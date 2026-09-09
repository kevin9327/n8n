import { compareExecutionListItems } from '@n8n/api-types';
import type { ExecutionSummaries } from '@n8n/db';
import { ExecutionListRepository, ExecutionRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope } from '@n8n/permissions';
import { ExecutionStatusList, type ExecutionSummary } from 'n8n-workflow';
import pLimit from 'p-limit';

import { EngineDataPlaneProxyService } from '@/services/engine-data-plane-proxy.service';

import {
	EngineV2ExecutionReader,
	type EngineV2SearchQuery,
} from './engine-v2-execution-reader.service';
import { parseExecutionCursor, type ExecutionPosition } from './execution-cursor';
import { isExecutionIdV2 } from './execution-id';
import { ExecutionService } from './execution.service';
import { mergeExecutionPages } from './merge-execution-pages';

/** Combines stores for the editor. Other API consumers keep their own contracts. */
@Service()
export class ExecutionListService {
	constructor(
		private readonly executionRepository: ExecutionRepository,
		private readonly executionListRepository: ExecutionListRepository,
		private readonly executionService: ExecutionService,
		private readonly reader: EngineV2ExecutionReader,
		private readonly dataPlane: EngineDataPlaneProxyService,
	) {}

	async findMany(query: ExecutionSummaries.RangeQuery, serializedCursor?: string) {
		const cursor = parseExecutionCursor(serializedCursor);
		const scope = await this.resolveV2Scope(query);
		const schedule = pLimit(4);
		const pageQuery = this.buildPageQuery(query);

		const [v1, v2, current] = await Promise.all([
			this.v1Page(pageQuery, cursor.v1),
			this.v2Page(pageQuery, scope, cursor.v2, schedule),
			this.isSplit(query) ? this.findCurrentExecutions(query, scope, schedule) : [],
		]);

		const merged = mergeExecutionPages([v1, v2], query.range.limit, cursor);
		const results = [...current, ...merged.results];
		await this.resolveWorkflowNames(results);

		return {
			results,
			nextCursor: merged.nextCursor,
			count: v1.count === -1 ? -1 : v1.count + v2.total,
			estimated: v1.estimated,
		};
	}

	/**
	 * Which workflows the data plane may be searched for, or `null` to skip it entirely.
	 *
	 * The data plane search has no equivalent for a metadata, annotation, vote, or
	 * workflow-version filter — those only apply to control-plane (v1) executions — so a
	 * query using one of them is answered from the control plane alone, `null` here.
	 */
	async resolveV2Scope(query: ExecutionSummaries.RangeQuery): Promise<string[] | 'all' | null> {
		if (!this.dataPlane.isAvailable() || !query.user) return null;
		if (
			query.metadata?.length ||
			query.annotationTags?.length ||
			query.vote ||
			query.workflowVersionId !== undefined
		)
			return null;
		if (
			hasGlobalScope(query.user, 'workflow:read') &&
			!query.workflowId &&
			!query.projectId &&
			query.isArchived === undefined &&
			!query.workflowBooleanSettings?.length
		)
			return 'all';
		const ids = await this.executionListRepository.findWorkflowIdsForExecutionList(query);
		return ids.length ? ids : null;
	}

	/** Without a status filter, the completed page excludes current (new/running) executions. */
	private isSplit(query: ExecutionSummaries.RangeQuery): boolean {
		return !query.status?.length;
	}

	/** The completed-only, `startedAt`-ordered query both stores page against. */
	private buildPageQuery(query: ExecutionSummaries.RangeQuery): ExecutionSummaries.RangeQuery {
		return {
			...query,
			order: { startedAt: 'DESC' },
			...(this.isSplit(query)
				? { status: ExecutionStatusList.filter((s) => s !== 'new' && s !== 'running') }
				: {}),
		};
	}

	private async v2Page(
		query: ExecutionSummaries.RangeQuery,
		scope: string[] | 'all' | null,
		before: ExecutionPosition | undefined,
		schedule: ReturnType<typeof pLimit>,
	) {
		if (!scope) return { items: [], total: 0, hasMore: false };
		return await this.reader.findMany(this.toV2Query(query, before), scope, { schedule });
	}

	/** Narrows a control-plane range query down to what the data plane search understands. */
	private toV2Query(
		query: ExecutionSummaries.RangeQuery,
		before?: ExecutionPosition,
	): EngineV2SearchQuery {
		return {
			status: query.status,
			mode: query.mode,
			startedAfter: query.startedAfter,
			startedBefore: query.startedBefore,
			before,
			limit: query.range.limit,
		};
	}

	/** Resolves and assigns `workflowName` on every v2 result, in place. */
	private async resolveWorkflowNames(results: ExecutionSummary[]): Promise<void> {
		const v2Results = results.filter((item) => isExecutionIdV2(item.id));
		if (!v2Results.length) return;

		const uniqV2WorkflowIds = [...new Set(v2Results.map((item) => item.workflowId))];
		const workflowNames =
			await this.executionListRepository.findNamesForExecutionList(uniqV2WorkflowIds);
		const namesById = new Map(workflowNames.map((workflow) => [workflow.id, workflow.name]));

		for (const item of v2Results) item.workflowName = namesById.get(item.workflowId);
	}

	private async v1Page(query: ExecutionSummaries.RangeQuery, before?: ExecutionPosition) {
		const { range, ...filters } = query;
		const [rows, count] = await Promise.all([
			this.executionRepository.findManyByRangeQuery({
				...query,
				range: { limit: range.limit + 1, beforeId: before?.id },
			}),
			this.executionService.getExecutionsCountForQuery({ ...filters, kind: 'count' }),
		]);
		return { items: rows.slice(0, range.limit), hasMore: rows.length > range.limit, ...count };
	}

	/** Current executions from both stores: running first, then newest, capped to `limit`. */
	private async findCurrentExecutions(
		query: ExecutionSummaries.RangeQuery,
		scope: string[] | 'all' | null,
		schedule: ReturnType<typeof pLimit>,
	): Promise<ExecutionSummary[]> {
		const currentQuery: ExecutionSummaries.RangeQuery = {
			...query,
			status: ['new', 'running'],
			range: { limit: query.range.limit },
			order: { top: 'running' },
		};
		const [v1, v2] = await Promise.all([
			this.executionRepository.findManyByRangeQuery(currentQuery),
			scope ? this.findCurrentExecutionsV2(this.toV2Query(currentQuery), scope, schedule) : [],
		]);
		return [...v1, ...v2]
			.sort(
				(a, b) =>
					Number(b.status === 'running') - Number(a.status === 'running') ||
					compareExecutionListItems(a, b),
			)
			.slice(0, query.range.limit);
	}

	private async findCurrentExecutionsV2(
		query: EngineV2SearchQuery,
		scope: string[] | 'all',
		schedule: ReturnType<typeof pLimit>,
	) {
		const running = await this.reader.findMany({ ...query, status: ['running'] }, scope, {
			includeTotal: false,
			schedule,
		});
		const remaining = query.limit - running.items.length;
		if (!remaining) return running.items;
		const queued = await this.reader.findMany(
			{ ...query, status: ['new'], limit: remaining },
			scope,
			{ includeTotal: false, schedule },
		);
		return running.items.concat(queued.items);
	}
}
