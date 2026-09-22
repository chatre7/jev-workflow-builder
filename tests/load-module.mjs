import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Execute unchanged application modules with external services explicitly isolated. */
export function createModuleLoader({ stubs = {}, env = {}, globals = {} } = {}) {
  const context = vm.createContext({
    console, Buffer, URL, URLSearchParams, Request, Response, ReadableStream,
    TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    process: { env }, ...globals,
  });
  const modules = new Map();
  async function resolve(specifier, parent = path.join(root, "_test.mjs")) {
    const relative = specifier.startsWith(".");
    const unresolved = relative ? path.resolve(path.dirname(parent), specifier) : specifier;
    const id = relative && !path.extname(unresolved) ? `${unresolved}.ts` : unresolved;
    const stubKey = Object.hasOwn(stubs, specifier) ? specifier
      : Object.hasOwn(stubs, unresolved) ? unresolved
      : Object.hasOwn(stubs, id) ? id : null;
    if (modules.has(id)) return modules.get(id);
    // Linking can request one dependency from several parents concurrently.
    // Cache construction itself so every importer receives the same class identities.
    const loading = (async () => {
      let mod;
      if (stubKey || specifier === "server-only" || specifier.startsWith("node:")) {
        const values = stubKey ? stubs[stubKey] : specifier === "server-only" ? {} : await import(specifier);
        mod = new vm.SyntheticModule(Object.keys(values), function () {
          for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context, identifier: id });
      } else {
        if (!relative || !id.startsWith(root)) throw new Error(`Unstubbed external dependency: ${specifier}`);
        const filename = path.extname(id) ? id : `${id}.ts`;
        const source = await fs.readFile(filename, "utf8");
        const { outputText } = ts.transpileModule(source, {
          fileName: filename,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        });
        mod = new vm.SourceTextModule(outputText, {
          context, identifier: filename,
          importModuleDynamically: async (name, referencing) => {
            const imported = await resolve(name, referencing.identifier);
            if (imported.status === "unlinked") await imported.link(linker);
            if (imported.status === "linked") await imported.evaluate();
            return imported;
          },
        });
      }
      return mod;
    })();
    modules.set(id, loading);
    return loading;
  }
  const linker = (specifier, parent) => resolve(specifier, parent.identifier);
  return async (relative) => {
    const mod = await resolve(`./${relative}`);
    if (mod.status === "unlinked") await mod.link(linker);
    if (mod.status === "linked") await mod.evaluate();
    return mod.namespace;
  };
}
