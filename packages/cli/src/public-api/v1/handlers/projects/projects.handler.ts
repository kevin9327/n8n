import { DeleteProjectDto, UpdateProjectWithRelationsDto } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Container } from '@n8n/di';

import type { PublicAPIEndpoint } from '../../shared/handler.types';
import {
	apiKeyHasScopeWithGlobalScopeFallback,
	isLicensed,
} from '../../shared/middlewares/global.middleware';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ProjectService } from '@/services/project.service.ee';

type ProjectHandlers = {
	updateProject: PublicAPIEndpoint<AuthenticatedRequest<{ projectId: string }>>;
	deleteProject: PublicAPIEndpoint<AuthenticatedRequest<{ projectId: string }>>;
};

const projectHandlers: ProjectHandlers = {
	updateProject: [
		isLicensed('feat:projectRole:admin'),
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'project:update' }),
		async (req, res) => {
			const payload = UpdateProjectWithRelationsDto.safeParse(req.body);
			if (payload.error) {
				throw new BadRequestError(payload.error.errors[0].message);
			}

			const { projectId } = req.params;
			await Container.get(ProjectService).updateProject(req.user, projectId, payload.data);

			return res.status(204).send();
		},
	],
	deleteProject: [
		isLicensed('feat:projectRole:admin'),
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'project:delete' }),
		async (req, res) => {
			const query = DeleteProjectDto.safeParse(req.query);
			if (query.error) {
				throw new BadRequestError(query.error.errors[0].message);
			}

			const { projectId } = req.params;
			const { transferId } = query.data;
			await Container.get(ProjectService).deleteProject(req.user, projectId, {
				migrateToProject: transferId,
			});

			return res.status(204).send();
		},
	],
};

export = projectHandlers;
