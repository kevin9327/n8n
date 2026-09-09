import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * An HTTPS server with a self-signed certificate that answers every request
 * with the smart HTTP advertisement of an empty repository. That is enough to
 * tell a TLS failure from a successful `git ls-remote`.
 */
export async function startSelfSignedGitServer() {
	const dir = await mkdtemp(path.join(tmpdir(), 'n8n-git-tls-'));
	const keyPath = path.join(dir, 'key.pem');
	const certPath = path.join(dir, 'cert.pem');
	execFileSync('openssl', [
		'req',
		'-x509',
		'-nodes',
		'-newkey',
		'rsa:2048',
		'-keyout',
		keyPath,
		'-out',
		certPath,
		'-days',
		'1',
		'-subj',
		'/CN=localhost',
		'-addext',
		'subjectAltName=DNS:localhost',
	]);
	const server = createServer(
		{ key: await readFile(keyPath), cert: await readFile(certPath) },
		(_request, response) => {
			response.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
			response.end('001e# service=git-upload-pack\n00000000');
		},
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Server has no port');

	return {
		dir,
		certPath,
		repositoryUrl: `https://localhost:${address.port}/repo.git`,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		},
	};
}
