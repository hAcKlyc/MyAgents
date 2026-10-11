import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Explicit native smoke must consume one prepared artifact's lock AND public
// contract, just like the build. Normal test pools retain the source snapshot.
const resourceRoot = resolve(process.env.MYAGENTS_DSH_NATIVE_SMOKE_RESOURCE_ROOT ?? 'src-tauri/resources');
const selection = JSON.parse(readFileSync(resolve(resourceRoot, 'integrated-runtimes/dsh-build-selection-v1.json'), 'utf8'));

export default defineConfig({
  define: {
    __MYAGENTS_DSH_BUILD_LOCK__: JSON.stringify(selection.lock),
    __MYAGENTS_DSH_BUILD_COMPATIBILITY__: JSON.stringify(selection.compatibility),
  },
  plugins: [{
    name: 'selected-dsh-native-test-contract',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('/contracts/myagents-dsh/public-contract.generated')) {
        return resolve(resourceRoot, 'integrated-runtimes/dsh/contracts/public-contract.generated.ts');
      }
    },
  }],
  test: {
    environment: 'node',
    include: ['src/server/integrated-runtimes/dsh/process-host.native.integration.test.ts'],
    setupFiles: ['src/test/setup-integration.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
  },
});
