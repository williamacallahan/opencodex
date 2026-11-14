import { providerConfigSchema } from "../../config/schema/leaf-validators";
import type { OcxProviderConfig } from "../../types";

export function applyProviderWindowsPatch(next: OcxProviderConfig, patch: unknown): string | undefined {
  if (patch === null) {
    delete next.modelContextWindows;
    return undefined;
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch) ||
      (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) {
    return "modelContextWindows must be a plain object or null";
  }
  const windows: Record<string, number> = Object.assign(Object.create(null), next.modelContextWindows ?? {});
  for (const [model, window] of Object.entries(patch)) {
    if (!model.trim()) return "modelContextWindows keys must be nonblank model ids";
    if (window === null) delete windows[model];
    else if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
      return "modelContextWindows values must be positive safe integers or null";
    } else windows[model] = window;
  }
  if (Object.keys(windows).length) next.modelContextWindows = windows;
  else delete next.modelContextWindows;
  return undefined;
}

export function applyProviderSamplingPatch(next: OcxProviderConfig, raw: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(raw, "modelSamplingDefaults")) return undefined;
  const patch = raw.modelSamplingDefaults;
  if (patch === null) {
    delete next.modelSamplingDefaults;
    return undefined;
  }
  if (typeof patch !== "object" || Array.isArray(patch) || patch === null) {
    return "modelSamplingDefaults must be an object or null";
  }
  const merged = Object.assign(Object.create(null), next.modelSamplingDefaults ?? {});
  for (const [model, sampling] of Object.entries(patch)) {
    if (!model.trim()) return "modelSamplingDefaults keys must be nonblank model ids";
    if (sampling === null) delete merged[model];
    else merged[model] = sampling;
  }
  const result = providerConfigSchema.shape.modelSamplingDefaults.safeParse(merged);
  if (!result.success) return "modelSamplingDefaults contains invalid sampling values";
  if (Object.keys(merged).length) next.modelSamplingDefaults = result.data;
  else delete next.modelSamplingDefaults;
  return undefined;
}
