import { EXTERNAL_RUNTIME_IDS } from '../../../shared/integrated-runtimes/identity';
import { selectedProxyRuntimeIds } from '../../../shared/proxyScope';
import type { ProxyScopeSettings } from '../../../shared/config-types';

export interface ProxyScopeSummaryDescriptor {
  key: string;
  values?: Record<string, string | number>;
}

export function describeProxyScopeSummary(args: {
  enabled: boolean;
  scope: ProxyScopeSettings;
  selectedProviderNames: string[];
}): ProxyScopeSummaryDescriptor[] {
  const { enabled, scope, selectedProviderNames } = args;
  if (!enabled) return [{ key: 'proxy.scopeDisabledHint' }];
  if (scope.mode === 'all') return [{ key: 'proxy.scopeAllSummary' }];

  const items: ProxyScopeSummaryDescriptor[] = [];
  const runtimeIds = selectedProxyRuntimeIds(scope);
  const runtimeCount = EXTERNAL_RUNTIME_IDS.filter(id => runtimeIds.includes(id)).length;
  if (scope.generalRequests) items.push({ key: 'proxy.scopeDialogGeneralRequests' });
  if (selectedProviderNames.length) {
    items.push(selectedProviderNames.length <= 3
      ? { key: 'proxy.scopeProviderNames', values: { names: selectedProviderNames.join(', ') } }
      : { key: 'proxy.scopeProviderCount', values: { count: selectedProviderNames.length } });
  }
  if (runtimeCount) items.push({ key: 'proxy.scopeRuntimeCount', values: { count: runtimeCount } });
  return items.length ? items : [{ key: 'proxy.scopeCustomEmptySummary' }];
}
