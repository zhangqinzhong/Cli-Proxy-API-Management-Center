/**
 * CPA Usage Keeper API
 * 用于检查凭证是否正常工作
 */

const DEFAULT_BASE_PATH = '/usage';

export interface QuotaRefreshTask {
  authIndex?: string;
  auth_index?: string;
  taskId?: string;
  task_id?: string;
}

export interface QuotaRefreshRejected {
  authIndex?: string;
  auth_index?: string;
  error: string;
}

export interface QuotaRefreshResponse {
  tasks?: QuotaRefreshTask[] | null;
  rejected?: QuotaRefreshRejected[] | null;
}

export interface QuotaRefreshTaskResponse {
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
  quota?: {
    quota?: Array<Record<string, unknown>>;
  };
}

export interface CheckQuotaResult {
  authIndex: string;
  success: boolean;
  error?: string;
}

/**
 * 获取 CPA Usage Keeper 的基础路径
 */
function getBasePath(): string {
  return (import.meta as any).env?.VITE_CPA_USAGE_KEEPER_BASE_PATH || DEFAULT_BASE_PATH;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `Request failed: ${response.status}`;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.error || body.message || text;
  } catch {
    return text;
  }
}

/**
 * 发送请求到 CPA Usage Keeper
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const basePath = getBasePath();
  const url = `${basePath}${path}`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json();
}

/**
 * 登录 CPA Usage Keeper。VPS 上 LOGIN_PASSWORD 与管理密钥一致。
 */
async function login(password: string): Promise<void> {
  const basePath = getBasePath();
  const response = await fetch(`${basePath}/api/v1/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

/**
 * 创建配额刷新任务
 */
async function createRefreshTask(authIndexes: string[]): Promise<QuotaRefreshResponse> {
  return fetchApi<QuotaRefreshResponse>('/api/v1/quota/refresh', {
    method: 'POST',
    body: JSON.stringify({ auth_indexes: authIndexes }),
  });
}

/**
 * 查询刷新任务状态
 */
async function getRefreshTask(taskId: string): Promise<QuotaRefreshTaskResponse> {
  return fetchApi<QuotaRefreshTaskResponse>(`/api/v1/quota/refresh/${encodeURIComponent(taskId)}`);
}

/**
 * 检查凭证是否正常
 * 返回每个凭证的检查结果
 */
export async function checkCredentialsQuota(
  authIndexes: string[],
  password?: string,
  onProgress?: (checked: number, total: number) => void
): Promise<CheckQuotaResult[]> {
  if (authIndexes.length === 0) {
    return [];
  }

  if (password?.trim()) {
    await login(password.trim());
  }

  const results: CheckQuotaResult[] = [];

  // 分批处理，每批最多 10 个
  const BATCH_SIZE = 10;
  const batches: string[][] = [];

  for (let i = 0; i < authIndexes.length; i += BATCH_SIZE) {
    batches.push(authIndexes.slice(i, i + BATCH_SIZE));
  }

  let checkedCount = 0;

  for (const batch of batches) {
    try {
      // 创建刷新任务
      const refreshResponse = await createRefreshTask(batch);

      // 处理被拒绝的凭证
      if (refreshResponse.rejected) {
        for (const rejected of refreshResponse.rejected) {
          const authIndex = rejected.authIndex || rejected.auth_index;
          if (!authIndex) continue;
          results.push({
            authIndex,
            success: false,
            error: rejected.error,
          });
          checkedCount++;
          onProgress?.(checkedCount, authIndexes.length);
        }
      }

      // 轮询每个任务的状态
      const taskMap = new Map<string, string>(); // authIndex -> taskId
      if (refreshResponse.tasks) {
        for (const task of refreshResponse.tasks) {
          const authIndex = task.authIndex || task.auth_index;
          const taskId = task.taskId || task.task_id;
          if (authIndex && taskId) {
            taskMap.set(authIndex, taskId);
          }
        }
      }

      // 等待所有任务完成
      const pendingTasks = new Map(taskMap);
      const maxPolls = 30; // 最多轮询 30 次（约 30 秒）
      let pollCount = 0;

      while (pendingTasks.size > 0 && pollCount < maxPolls) {
        pollCount++;

        const settled: string[] = [];

        await Promise.all(
          Array.from(pendingTasks.entries()).map(async ([authIndex, taskId]) => {
            try {
              const taskResponse = await getRefreshTask(taskId);

              if (taskResponse.status === 'completed') {
                results.push({
                  authIndex,
                  success: true,
                });
                settled.push(authIndex);
                checkedCount++;
                onProgress?.(checkedCount, authIndexes.length);
              } else if (taskResponse.status === 'failed') {
                results.push({
                  authIndex,
                  success: false,
                  error: taskResponse.error || 'Quota refresh failed',
                });
                settled.push(authIndex);
                checkedCount++;
                onProgress?.(checkedCount, authIndexes.length);
              }
              // 其他状态继续轮询
            } catch (err) {
              results.push({
                authIndex,
                success: false,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
              settled.push(authIndex);
              checkedCount++;
              onProgress?.(checkedCount, authIndexes.length);
            }
          })
        );

        for (const authIndex of settled) {
          pendingTasks.delete(authIndex);
        }

        if (pendingTasks.size > 0) {
          // 等待 1 秒后再次轮询
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // 处理超时的任务
      for (const [authIndex] of pendingTasks) {
        results.push({
          authIndex,
          success: false,
          error: 'Timeout waiting for quota refresh',
        });
        checkedCount++;
        onProgress?.(checkedCount, authIndexes.length);
      }
    } catch (err) {
      // 整批失败
      for (const authIndex of batch) {
        if (!results.some((r) => r.authIndex === authIndex)) {
          results.push({
            authIndex,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
          checkedCount++;
          onProgress?.(checkedCount, authIndexes.length);
        }
      }
    }
  }

  return results;
}

export const cpaUsageKeeperApi = {
  checkCredentialsQuota,
};
