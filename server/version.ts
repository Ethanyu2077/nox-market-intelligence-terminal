/** Read-only build identity. Never includes paths, env dumps or credentials. */
export interface VersionInfo {
  commit: string;
  buildTime: string | null;
  apiVersion: string;
  startedAt: number;
  node: string;
}

export function versionInfo(env: NodeJS.ProcessEnv, startedAt: number, node: string): VersionInfo {
  const commit = env.NOX_COMMIT_SHA?.trim() || env.GIT_COMMIT?.trim() || 'unknown';
  const buildTime = env.NOX_BUILD_TIME?.trim() || null;
  const apiVersion = env.NOX_API_VERSION?.trim() || '0.2.0';
  return { commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit : 'unknown', buildTime, apiVersion, startedAt, node };
}
