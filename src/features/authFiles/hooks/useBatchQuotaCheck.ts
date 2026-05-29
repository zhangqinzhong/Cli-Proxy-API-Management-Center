/**
 * 批量检查凭证配额并停用有问题的凭证
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi, cpaUsageKeeperApi } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';

export type BatchCheckStatus = 'idle' | 'checking' | 'disabling' | 'done';

export interface UseBatchQuotaCheckResult {
  status: BatchCheckStatus;
  progress: { checked: number; total: number };
  problematicFiles: string[];
  checkAndDisableProblematic: (
    files: AuthFileItem[],
    onSuccess?: () => Promise<void>
  ) => Promise<void>;
  resetState: () => void;
}

export function useBatchQuotaCheck(): UseBatchQuotaCheckResult {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const managementKey = useAuthStore((state) => state.managementKey);

  const [status, setStatus] = useState<BatchCheckStatus>('idle');
  const [progress, setProgress] = useState({ checked: 0, total: 0 });
  const [problematicFiles, setProblematicFiles] = useState<string[]>([]);

  const resetState = useCallback(() => {
    setStatus('idle');
    setProgress({ checked: 0, total: 0 });
    setProblematicFiles([]);
  }, []);

  const checkAndDisableProblematic = useCallback(
    async (files: AuthFileItem[], onSuccess?: () => Promise<void>) => {
      // 过滤出可检查的凭证
      const checkableFiles = files.filter((file) => !isRuntimeOnlyAuthFile(file) && !file.disabled);

      if (checkableFiles.length === 0) {
        showNotification(t('auth_files.batch_check_no_files'), 'info');
        return;
      }

      // 获取 authIndex
      const authIndexes: string[] = [];
      const authIndexToFile = new Map<string, AuthFileItem>();

      for (const file of checkableFiles) {
        const authIndex = file.authIndex != null ? String(file.authIndex) : file.name;
        authIndexes.push(authIndex);
        authIndexToFile.set(authIndex, file);
      }

      // 开始检查
      setStatus('checking');
      setProgress({ checked: 0, total: authIndexes.length });
      setProblematicFiles([]);

      try {
        const results = await cpaUsageKeeperApi.checkCredentialsQuota(
          authIndexes,
          managementKey,
          (checked, total) => {
            setProgress({ checked, total });
          }
        );

        // 找出有问题的凭证
        const problematic: string[] = [];
        for (const result of results) {
          if (!result.success) {
            const file = authIndexToFile.get(result.authIndex);
            if (file) {
              problematic.push(file.name);
            }
          }
        }

        setProblematicFiles(problematic);

        if (problematic.length === 0) {
          showNotification(t('auth_files.batch_check_all_good'), 'success');
          setStatus('done');
          return;
        }

        // 确认是否停用
        showConfirmation({
          title: t('auth_files.batch_disable_title'),
          message: t('auth_files.batch_disable_confirm', { count: problematic.length }),
          variant: 'danger',
          confirmText: t('auth_files.batch_disable_button'),
          onConfirm: async () => {
            setStatus('disabling');
            let success = 0;
            let failed = 0;

            for (const fileName of problematic) {
              try {
                await authFilesApi.setStatus(fileName, true); // true = disabled
                success++;
              } catch {
                failed++;
              }
            }

            if (failed === 0) {
              showNotification(
                t('auth_files.batch_disable_success', { count: success }),
                'success'
              );
            } else {
              showNotification(
                t('auth_files.batch_disable_partial', { success, failed }),
                failed > 0 ? 'error' : 'warning'
              );
            }

            setStatus('done');

            // 调用成功回调刷新数据
            if (onSuccess) {
              await onSuccess();
            }
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(t('auth_files.batch_check_failed', { message }), 'error');
        setStatus('idle');
      }
    },
    [managementKey, showNotification, showConfirmation, t]
  );

  return {
    status,
    progress,
    problematicFiles,
    checkAndDisableProblematic,
    resetState,
  };
}
