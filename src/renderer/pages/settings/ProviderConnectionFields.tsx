import { useTranslation } from "react-i18next";
import CustomSelect from "@/components/CustomSelect";
import type { ApiProtocol } from "@/config/types";

export interface ProviderConnectionValue {
  apiProtocol: ApiProtocol; baseUrl: string; authType: "auth_token" | "api_key" | "both" | "auth_token_clear_api_key";
  upstreamFormat: "chat_completions" | "responses"; maxOutputTokens: string;
  maxOutputTokensParamName: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
}

/** Controlled connection controls shared by Settings and remote Host drafts.
 * The caller owns persistence; this component never writes desktop config. */
export function ProviderConnectionFields({
  value,
  onChange,
  idPrefix,
  allowBoth = false,
}: {
  value: ProviderConnectionValue;
  onChange: (next: ProviderConnectionValue) => void;
  idPrefix: string;
  allowBoth?: boolean;
}) {
  const { t } = useTranslation("settings");
  const input = "w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none";
  return <div className="space-y-4">
    <div>
      <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">{t("providers.custom.apiProtocol")}</label>
      {value.apiProtocol === "openai" && <p className="mb-1.5 text-xs text-[var(--ink-muted)]">{t("providers.custom.bridgeWarning")}</p>}
      <div className="mt-1 flex gap-4">
        {(["anthropic", "openai"] as const).map(protocol => <label key={protocol} className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={`${idPrefix}-protocol`} checked={value.apiProtocol === protocol} onChange={() => onChange({ ...value, apiProtocol: protocol, authType: protocol === "openai" ? "api_key" : "auth_token", ...(protocol === "openai" ? {} : { upstreamFormat: "chat_completions" as const, maxOutputTokensParamName: value.maxOutputTokensParamName === "max_output_tokens" ? "max_tokens" : value.maxOutputTokensParamName }) })} className="accent-[var(--ink)]" />
          <span className="text-sm text-[var(--ink)]">{t(protocol === "openai" ? "providers.custom.openaiProtocol" : "providers.custom.anthropicProtocol")}</span>
        </label>)}
      </div>
    </div>
    <div>
      <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t("providers.custom.baseUrl")} <span className="text-[var(--error)]">*</span></label>
      <input type="url" value={value.baseUrl} onChange={e => onChange({ ...value, baseUrl: e.target.value })} placeholder={value.apiProtocol === "openai" ? "https://api.openai.com/v1" : "https://api.example.com/anthropic"} className={input} />
    </div>
    {value.apiProtocol === "openai" && <>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t("providers.custom.upstreamFormat")}</label>
        <div className="flex gap-4">{(["chat_completions", "responses"] as const).map(format => <label key={format} className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={`${idPrefix}-format`} checked={value.upstreamFormat === format} onChange={() => onChange({ ...value, upstreamFormat: format, maxOutputTokensParamName: format === "responses" ? "max_output_tokens" : value.maxOutputTokensParamName === "max_output_tokens" ? "max_tokens" : value.maxOutputTokensParamName })} className="accent-[var(--ink)]" />
          <span className="text-sm text-[var(--ink)]">{format === "responses" ? "Responses API" : "Chat Completions"}</span>
        </label>)}</div>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t("providers.custom.maxOutputTokens")}</label>
        <div className="flex items-center gap-2">
          <CustomSelect value={value.maxOutputTokensParamName} onChange={v => onChange({ ...value, maxOutputTokensParamName: v as typeof value.maxOutputTokensParamName })} options={value.upstreamFormat === "responses" ? [{ value: "max_output_tokens", label: "max_output_tokens" }] : [{ value: "max_tokens", label: "max_tokens" }, { value: "max_completion_tokens", label: "max_completion_tokens" }]} compact className="shrink-0" />
          <input type="number" value={value.maxOutputTokens} onChange={e => onChange({ ...value, maxOutputTokens: e.target.value })} placeholder={t("providers.custom.unlimitedPlaceholder")} className={input} />
        </div>
      </div>
    </>}
    {value.apiProtocol === "anthropic" && <div>
      <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">{t("providers.custom.authType")}</label>
      <p className="mb-1.5 text-xs text-[var(--ink-muted)]">{t("providers.custom.authTypeDescription")}</p>
      <div className="flex flex-wrap gap-4">{(["auth_token", "api_key", ...(allowBoth ? ["both" as const, "auth_token_clear_api_key" as const] : [])] as const).map(auth => <label key={auth} className="flex cursor-pointer items-center gap-2">
        <input type="radio" name={`${idPrefix}-auth`} checked={value.authType === auth} onChange={() => onChange({ ...value, authType: auth })} className="accent-[var(--ink)]" />
        <span className="text-sm text-[var(--ink)]">{auth === "auth_token" ? "AUTH_TOKEN" : auth === "api_key" ? "API_KEY" : auth === "both" ? "AUTH_TOKEN + API_KEY" : "AUTH_TOKEN (clear API_KEY)"}</span>
      </label>)}</div>
    </div>}
  </div>;
}
