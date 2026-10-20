import type {
  ApiProtocol,
  ModelAliases,
  ModelEntity,
  Provider,
  ProviderAuthType,
} from '@/config/types';

export function parsePositiveInt(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n <= 0 ? undefined : n;
}

export interface CustomProviderForm {
  name: string;
  cloudProvider: string;
  apiProtocol: ApiProtocol;
  baseUrl: string;
  authType: Extract<ProviderAuthType, 'auth_token' | 'api_key'>;
  models: ModelEntity[];
  primaryModel: string;
  apiKey: string;
  upstreamFormat: 'chat_completions' | 'responses';
}

export const EMPTY_CUSTOM_FORM: CustomProviderForm = {
  name: '',
  cloudProvider: '',
  apiProtocol: 'anthropic',
  baseUrl: '',
  authType: 'auth_token',
  models: [],
  primaryModel: '',
  apiKey: '',
  upstreamFormat: 'chat_completions',
};

export interface ProviderEditForm {
  provider: Provider;
  customModels: string[];
  removedModels: string[];
  newModelInput: string;
  editName?: string;
  editCloudProvider?: string;
  editApiProtocol?: ApiProtocol;
  editBaseUrl?: string;
  editAuthType?: Extract<ProviderAuthType, 'auth_token' | 'api_key'>;
  editMaxOutputTokens?: string;
  editMaxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  editUpstreamFormat?: 'chat_completions' | 'responses';
  editModelAliases?: ModelAliases;
  showAdvanced?: boolean;
}

/** Both the draft manager and final create action use the same provider projection. */
export function buildCustomProvider(form: CustomProviderForm, id: string): Provider {
  return {
    id, name: form.name, vendor: 'Custom', cloudProvider: form.cloudProvider || '自定义',
    type: 'api', isBuiltin: false,
    primaryModel: form.models.some(model => model.model === form.primaryModel)
      ? form.primaryModel : form.models[0]?.model ?? '',
    authType: form.authType,
    apiProtocol: form.apiProtocol === 'openai' ? 'openai' : undefined,
    ...(form.apiProtocol === 'openai' && form.upstreamFormat !== 'chat_completions'
      ? { upstreamFormat: form.upstreamFormat } : {}),
    config: { baseUrl: form.baseUrl }, models: form.models,
  };
}
