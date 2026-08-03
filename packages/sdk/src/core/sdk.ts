/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import { setSdkLogger } from './diag.ts';
import { parseExportUrl } from './exportUrl.ts';
import type {
  CommonConfig,
  LogsConfig,
  RootConfig,
  TracesConfig,
  WebSdk,
} from './types.ts';

type WebSdkFactory<T> = (config?: T) => WebSdk;

interface SdkFactories {
  logs?: WebSdkFactory<LogsConfig>;
  traces?: WebSdkFactory<TracesConfig>;
}

/**
 * Utility functions to extract the configurations from the factory
 * functions and remove the common properties (which will be already
 * available at the config root)
 */
type RemoveCommonProps<T> = Omit<T, keyof CommonConfig>;
type ExtractConfigs<T> = Partial<{
  [K in keyof T]: T[K] extends WebSdkFactory<infer C>
    ? RemoveCommonProps<C>
    : never;
}>;

/**
 * Concrete view of the config used inside `startSdk`. It is structurally a
 * superset of `RootConfig & ExtractConfigs<T>` for any `T`, so the returned
 * function stays assignable to the precise, factory-derived public type while
 * the body can read each signal's config without casting.
 */
type CombinedConfig = RootConfig & {
  logs?: RemoveCommonProps<LogsConfig>;
  traces?: RemoveCommonProps<TracesConfig>;
};

const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';
const DEFAULT_CONFIG: RootConfig = {
  disabled: false,
  logLevel: 'INFO',
};
const NOOP_SDK = { shutdown: () => Promise.resolve() };

/**
 * Combines different SDK factory functions into a single one
 * which accepts a global configuration along
 */
export function combineSdks<T extends SdkFactories>(
  factories: T,
): WebSdkFactory<RootConfig & ExtractConfigs<T>> {
  // The returned function will transform some of the global
  // configuration options to signal specific ones if the SDK is available
  return function startSdk(config?: CombinedConfig) {
    // Check the global config and set defaults
    const rootConfig = Object.assign({}, DEFAULT_CONFIG, config) as RootConfig;

    // Set the logger
    setSdkLogger(rootConfig?.logLevel);

    if (config?.disabled) {
      diag.debug('Browser SDK disabled by configuration.');
      // TODO: need to discuss with the SIG if it's better to return `undefined`
      return NOOP_SDK;
    }

    // TODO: questions (for the SIG?)
    // - accept resource detectors?
    // - how to avoid creating different resources (here and in signals)
    //   - in the config? may be misleading for users seeing
    //   - maybe using an internal module with set/get like diag
    rootConfig.resourceAttributes ??= {};
    if (rootConfig.serviceName) {
      rootConfig.resourceAttributes['service.name'] = rootConfig.serviceName;
    }
    if (rootConfig.serviceVersion) {
      rootConfig.resourceAttributes['service.version'] =
        rootConfig.serviceVersion;
    }

    // Export
    rootConfig.exportConfig = {
      url: DEFAULT_OTLP_ENDPOINT,
      ...rootConfig.exportConfig,
    };

    const sdks: WebSdk[] = [];

    // Resolve each signal's config once so it can be validated here and reused
    // when starting the signals below.
    const logsConfig: LogsConfig = config?.logs || {};
    const tracesConfig: TracesConfig = config?.traces || {};

    // Validate the shared root endpoint. Signals that do not set their own
    // export URL inherit this one (with a signal-specific path appended), so
    // its validity gates only those signals.
    const endpointUrl = parseExportUrl(
      rootConfig.exportConfig?.url || DEFAULT_OTLP_ENDPOINT,
    );

    // Validate each signal independently. A signal can start when its own
    // explicit URL is valid, or — if it has none — when the shared root
    // endpoint is valid. This lets one signal start even when the other's URL
    // is broken, rather than failing the whole SDK on the first invalid URL.
    const isSignalUrlValid = (scope: string, signalUrl?: string): boolean =>
      signalUrl
        ? Boolean(parseExportUrl(signalUrl, scope))
        : Boolean(endpointUrl);
    const isLogsUrlValid = isSignalUrlValid(
      'Logs SDK',
      logsConfig.exportConfig?.url,
    );
    const isTracesUrlValid = isSignalUrlValid(
      'Traces SDK',
      tracesConfig.exportConfig?.url,
    );

    // Only bail out entirely when no signal can export.
    if (!isLogsUrlValid && !isTracesUrlValid) {
      // TODO: need to discuss with the SIG if it's better to return `undefined`
      return NOOP_SDK;
    }

    // Start logs
    if (factories.logs && isLogsUrlValid) {
      const isGenericEndpoint = !logsConfig.exportConfig?.url;

      // Propagate root configs to signal configs only when the signal does not
      // have custom processors. When processors are provided, exportConfig and
      // batchProcessorConfig are intentionally ignored per the LogsConfig docs.
      if (!logsConfig.processors) {
        if (!logsConfig.batchProcessorConfig) {
          logsConfig.batchProcessorConfig =
            rootConfig.batchProcessorConfig || {};
        }
        if (!logsConfig.exportConfig) {
          logsConfig.exportConfig = rootConfig.exportConfig || {};
        }
      }

      // Set the path if endpoint comes from general config
      if (isGenericEndpoint && endpointUrl && logsConfig.exportConfig) {
        endpointUrl.pathname = '/v1/logs';
        logsConfig.exportConfig.url = endpointUrl.href;
      }
      logsConfig.resourceAttributes = rootConfig.resourceAttributes;
      sdks.push(factories.logs(logsConfig));
    }

    // Start traces
    if (factories.traces && isTracesUrlValid) {
      const isGenericEndpoint = !tracesConfig.exportConfig?.url;

      // Propagate root configs to signal configs only when the signal does not
      // have custom processors. When processors are provided, exportConfig and
      // batchProcessorConfig are intentionally ignored per the TracesConfig docs.
      if (!tracesConfig.processors) {
        if (!tracesConfig.batchProcessorConfig) {
          tracesConfig.batchProcessorConfig =
            rootConfig.batchProcessorConfig || {};
        }
        if (!tracesConfig.exportConfig) {
          tracesConfig.exportConfig = rootConfig.exportConfig || {};
        }
      }

      // Set the path if endpoint comes from general config
      if (isGenericEndpoint && endpointUrl && tracesConfig.exportConfig) {
        endpointUrl.pathname = '/v1/traces';
        tracesConfig.exportConfig.url = endpointUrl.href;
      }
      tracesConfig.resourceAttributes = rootConfig.resourceAttributes;
      sdks.push(factories.traces(tracesConfig));
    }

    return {
      shutdown() {
        return Promise.allSettled(sdks.map((s) => s.shutdown())).then(
          (results) => {
            const errors = [];
            for (const res of results) {
              if (res.status === 'rejected') {
                errors.push(res.reason);
              }
            }
            if (errors.length > 0) {
              throw new Error(
                `Shutdown process failed. Reason: ${errors.join(', ')}`,
              );
            }
          },
        );
      },
    };
  };
}
