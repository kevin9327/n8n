import type { ModuleRegistry } from '@n8n/backend-common';
import { LICENSE_FEATURES } from '@n8n/constants';
import type { AuthenticatedRequest } from '@n8n/db';
import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import type { Response } from 'express';
import { mock } from 'vitest-mock-extended';

import { ServiceUnavailableError } from '@/errors/response-errors/service-unavailable.error';

import { NodeTypePoliciesPublicController } from '../node-type-policies.public.controller';

/**
 * Every public route must carry the same guards as the internal controllers it mirrors: the
 * node type policies license feature, the `nodeTypePolicy:manage` API-key scope, and a
 * `nodeTypePolicy:manage` RBAC check that is global-only everywhere except on the two
 * project-scoped routes.
 */
describe('NodeTypePoliciesPublicController route metadata', () => {
	const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
		NodeTypePoliciesPublicController as never,
	);
	const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
		handlerName,
		route,
	}));
	const projectHandlers = new Set(['getProjectPolicy', 'putProjectPolicy']);

	it('registers every route of the internal instance and project controllers', () => {
		expect(routeCases.map(({ handlerName }) => handlerName).sort()).toEqual(
			[
				'createPolicyDocument',
				'deletePolicyDocument',
				'getInstancePolicy',
				'getPolicyDocument',
				'getProjectPolicy',
				'listPolicyDocuments',
				'putInstancePolicy',
				'putProjectPolicy',
				'replaceAttachments',
				'updatePolicyDocument',
			].sort(),
		);
	});

	it.each(routeCases)(
		'$handlerName requires the nodeTypePolicy:manage API key scope',
		({ route }) => {
			expect(route.apiKeyScope).toBe('nodeTypePolicy:manage');
		},
	);

	it.each(routeCases)(
		'$handlerName is gated by a nodeTypePolicy:manage RBAC check',
		({ route }) => {
			expect(route.accessScope?.scope).toBe('nodeTypePolicy:manage');
		},
	);

	it.each(routeCases)(
		'$handlerName is global-only unless it addresses a project',
		({ handlerName, route }) => {
			expect(route.accessScope?.globalOnly).toBe(!projectHandlers.has(handlerName));
		},
	);

	it.each(routeCases)(
		'$handlerName is gated by the node type policies license feature',
		({ route }) => {
			expect(route.licenseFeature).toBe(LICENSE_FEATURES.NODE_TYPE_POLICIES);
		},
	);

	it.each(routeCases)(
		'$handlerName documents a success status and the 503 for an inactive module',
		({ route }) => {
			expect(route.successStatus).toBeDefined();
			expect(route.errorResponses?.some((response) => response.status === 503)).toBe(true);
		},
	);

	it.each(routeCases)('$handlerName declares a response DTO unless it answers 204', ({ route }) => {
		if (route.successStatus === 204) {
			expect(route.responseDto).toBeUndefined();
		} else {
			expect(route.responseDto).toBeDefined();
		}
	});
});

describe('NodeTypePoliciesPublicController with the module disabled', () => {
	const moduleRegistry = mock<ModuleRegistry>();
	const controller = new NodeTypePoliciesPublicController(moduleRegistry);
	const req = mock<AuthenticatedRequest>();
	const res = mock<Response>();

	beforeEach(() => {
		moduleRegistry.isActive.mockReturnValue(false);
	});

	it('answers 503 before touching the service', async () => {
		await expect(controller.getInstancePolicy()).rejects.toThrow(ServiceUnavailableError);
		await expect(controller.getProjectPolicy(req, res, 'project-id')).rejects.toThrow(
			ServiceUnavailableError,
		);
		await expect(controller.getPolicyDocument(req, res, 'policy-id')).rejects.toThrow(
			ServiceUnavailableError,
		);
		await expect(controller.deletePolicyDocument(req, res, 'policy-id')).rejects.toThrow(
			ServiceUnavailableError,
		);

		expect(moduleRegistry.isActive).toHaveBeenCalledWith('type-availability-policies');
	});
});
