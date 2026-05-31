/**
 * 批量检查凭证配额：停用有问题的 / 启用恢复正常的
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi, cpaUsageKeeperApi } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';

export type BatchCheckStatus =
  | 'idle'
  | 'checking-disable'
  | 'checking-enable'
  | 'disabling'
  | 'enabling'
  | 'done';

export interface UseBatchQuotaCheckResult {
  status: BatchCheckStatus;
  progress: { checked: number; total: number };
  checkAndDisableProblematic: (
    files: AuthFileItem[],
    onSuccess?: () => Promise<void>
  ) => Promise<void>;
  checkAndEnableRecovered: (
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

  const resetState = useCallback(() => {
    setStatus('idle');
    setProgress({ checked: 0, total: 0 });
  }, []);

  /** 内部通用检查逻辑 */
  const runCheck = useCallback(
    async (
      checkingStatus: BatchCheckStatus,
      targetFiles: AuthFileItem[],
      onProgress: (checked: number, total: number) => void
    ) => {
      const authIndexes: string[] = [];
      const authIndexToFile = new Map<string, AuthFileItem>();
      for (const file of targetFiles) {
        const authIndex = file.authIndex != null ? String(file.authIndex) : file.name;
        authIndexes.push(authIndex);
        authIndexToFile.set(authIndex, file);
      }
      setStatus(checkingStatus);
      setProgress({ checked: 0, total: authIndexes.length });
      const results = await cpaUsageKeeperApi.checkCredentialsQuota(
        authIndexes,
        managementKey,
        onProgress
      );
      return { results, authIndexToFile };
    },
    [managementKey]
  );

  /** 检查未停用凭证，停用有问题的 */
  const checkAndDisableProblematic = useCallback(
    async (files: AuthFileItem[], onSuccess?: () => Promise<void>) => {
      const targetFiles = files.filter((f) => !isRuntimeOnlyAuthFile(f) && !f.disabled);
      if (targetFiles.length === 0) {
        showNotification(t('auth_files.batch_check_no_files'), 'info');
        return;
      }
      try {
        const { results, authIndexToFile } = await runCheck(
          'checking-disable',
          targetFiles,
          (checked, total) => setProgress({ checked, total })
        );
        const problematic: string[] = [];
        for (const r of results) {
          if (!r.success) {
            const file = authIndexToFile.get(r.authIndex);
            if (file) problematic.push(file.name);
          }
        }
        if (problematic.length === 0) {
          showNotification(t('auth_files.batch_check_all_good'), 'success');
          setStatus('done');
          return;
        }
        showConfirmation({
          title: t('auth_files.batch_disable_title'),
          message: t('auth_files.batch_disable_confirm', { count: problematic.length }),
          variant: 'danger',
          confirmText: t('auth_files.batch_disable_button'),
          onConfirm: async () => {
            setStatus('disabling');
            let ok = 0,
              fail = 0;
            for (const name of problematic) {
              try {
                await authFilesApi.setStatus(name, true);
                ok++;
              } catch {
                fail++;
              }
            }
            if (fail === 0) {
              showNotification(t('auth_files.batch_disable_success', { count: ok }), 'success');
            } else {
              showNotification(
                t('auth_files.batch_disable_partial', { success: ok, failed: fail }),
                'warning'
              );
            }
            setStatus('done');
            if (onSuccess) await onSuccess();
          },
        });
      } catch (err) {
        showNotification(
          t('auth_files.batch_check_failed', {
            message: err instanceof Error ? err.message : t('common.unknown_error'),
          }),
          'error'
        );
        setStatus('idle');
      }
    },
    [runCheck, showNotification, showConfirmation, t]
  );

  /** 检查已停用凭证，启用恢复正常的 */
  const checkAndEnableRecovered = useCallback(
    async (files: AuthFileItem[], onSuccess?: () => Promise<void>) => {
      const targetFiles = files.filter(
        (f) => !isRuntimeOnlyAuthFile(f) && f.disabled === true && f.status !== 'error'
      );
      if (targetFiles.length === 0) {
        showNotification(t('auth_files.batch_check_no_disabled'), 'info');
        return;
      }
      try {
        const { results, authIndexToFile } = await runCheck(
          'checking-enable',
          targetFiles,
          (checked, total) => setProgress({ checked, total })
        );
        const recovered: string[] = [];
        for (const r of results) {
          if (r.success) {
            const file = authIndexToFile.get(r.authIndex);
            if (file) recovered.push(file.name);
          }
        }
        if (recovered.length === 0) {
          showNotification(t('auth_files.batch_check_none_recovered'), 'info');
          setStatus('done');
          return;
        }
        showConfirmation({
          title: t('auth_files.batch_enable_title'),
          message: t('auth_files.batch_enable_confirm', { count: recovered.length }),
          variant: 'primary',
          confirmText: t('auth_files.batch_enable_button'),
          onConfirm: async () => {
            setStatus('enabling');
            let ok = 0,
              fail = 0;
            for (const name of recovered) {
              try {
                await authFilesApi.setStatus(name, false);
                ok++;
              } catch {
                fail++;
              }
            }
            if (fail === 0) {
              showNotification(t('auth_files.batch_enable_success', { count: ok }), 'success');
            } else {
              showNotification(
                t('auth_files.batch_enable_partial', { success: ok, failed: fail }),
                'warning'
              );
            }
            setStatus('done');
            if (onSuccess) await onSuccess();
          },
        });
      } catch (err) {
        showNotification(
          t('auth_files.batch_check_failed', {
            message: err instanceof Error ? err.message : t('common.unknown_error'),
          }),
          'error'
        );
        setStatus('idle');
      }
    },
    [runCheck, showNotification, showConfirmation, t]
  );

  return {
    status,
    progress,
    checkAndDisableProblematic,
    checkAndEnableRecovered,
    resetState,
  };
}
