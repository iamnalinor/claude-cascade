import {
  type CompilationContext,
  type Compiled,
  type CompileDependencies,
  compileSource,
} from "./compile-source.ts";
import { type Source } from "./source-config.ts";
import { IncompatibleSource } from "./source-request.ts";
import {
  diagnosticReason,
  SourceCompilationError,
  type SourceReport,
} from "./subscription-diagnostics.ts";

export type SourceResults = { compiled: Compiled[]; reports: SourceReport[]; incompatible: number };

export async function collectSources(
  configured: Source[],
  context: CompilationContext,
  dependencies: CompileDependencies,
): Promise<SourceResults> {
  const output: SourceResults = { compiled: [], reports: [], incompatible: 0 };
  for (let index = 0; index < configured.length; index += 3) {
    const batch = configured.slice(index, index + 3);
    const completed = await Promise.allSettled(
      batch.map(async (source) => await compileSource(source, context, dependencies)),
    );
    for (const [offset, result] of completed.entries()) {
      const source = batch[offset];
      if (source === undefined) {
        throw new Error("missing-source-result");
      }
      if (result.status === "fulfilled") {
        output.compiled.push(result.value);
        output.reports.push({
          id: source.id,
          status: "ok",
          input: result.value.input,
          compiled: result.value.profiles.length,
          returned: 0,
          issues: [...result.value.issues],
        });
      } else {
        const error: unknown = result.reason;
        output.reports.push(failedSource(source.id, error));
        output.incompatible += Number(error instanceof IncompatibleSource);
      }
    }
  }
  return output;
}

function failedSource(id: string, error: unknown): SourceReport {
  return {
    id,
    status: "failed",
    input: error instanceof SourceCompilationError ? error.input : null,
    compiled: 0,
    returned: 0,
    issues: error instanceof SourceCompilationError ? error.issues : [],
    error: diagnosticReason(error),
  };
}
