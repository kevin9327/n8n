import type { ZodError, ZodIssue } from 'zod';

/** A union reports a missing value once per member, each at the union's own path. */
function isMissingValue(issue: ZodIssue): boolean {
	if (issue.code === 'invalid_type') return issue.received === 'undefined';

	if (issue.code === 'invalid_union') {
		const path = issue.path.join('/');
		return issue.unionErrors.every((error) =>
			error.errors.some((inner) => inner.path.join('/') === path && isMissingValue(inner)),
		);
	}

	return false;
}

/**
 * Names the offending field in a validation failure, the way the legacy validator did:
 * Ajv's `errorsText(errors, { dataVar: 'request' })` renders `request/body/active is read-only`.
 * Without the path, a message written as a fragment ("is read-only", "Required") has no subject.
 */
export function formatValidationError(location: 'body' | 'query', error: ZodError): string {
	const issue = error.errors[0];
	if (!issue) return 'Invalid request';

	// A missing field is the one case where Zod and Ajv disagree on more than wording: Ajv blames
	// the containing object and names the field in the message, Zod blames the field. Two public
	// API tests already pin Ajv's form, so keep it.
	if (issue.path.length > 0 && isMissingValue(issue)) {
		const parent = issue.path.slice(0, -1);
		const field = issue.path[issue.path.length - 1];
		const prefix = parent.length > 0 ? `/${parent.join('/')}` : '';

		return `request/${location}${prefix} must have required property '${field}'`;
	}

	const path = issue.path.length > 0 ? `/${issue.path.join('/')}` : '';

	return `request/${location}${path} ${issue.message}`;
}
