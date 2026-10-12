/**
 * Fails when a symbol a package exports has no doc comment.
 *
 * Walks each package's public entry points with the TypeScript compiler API
 * over the built declarations, so it sees exactly what a user imports —
 * re-exports followed, internals that `stripInternal` removed left out — and
 * checks every exported symbol and its members. typedoc would do this, but
 * does not run on TypeScript 7. Run `pnpm build` first.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

// The compiler API ships with TypeScript 5's JavaScript implementation; the
// repository builds with TypeScript 7, which has none, so this loads the API
// the same way a bundler plugin would, from a 5.x copy.
const require = createRequire(import.meta.url);
const ts = require("typescript-api") as typeof import("typescript");

const entries = [
  "packages/core/dist/index.d.ts",
  "packages/client/dist/index.d.ts",
  "packages/serverquery/dist/index.d.ts",
].map((p) => resolve(p));

const program = ts.createProgram(entries, { skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();

const undocumented = new Set<string>();
const seen = new Set<import("typescript").Symbol>();

function documented(symbol: import("typescript").Symbol): boolean {
  if (symbol.getDocumentationComment(checker).length > 0) return true;
  // A symbol whose declarations sit outside these packages (a re-exported
  // Node or lib type) is not ours to document.
  return (symbol.declarations ?? []).every(
    (d) => !d.getSourceFile().fileName.includes("/packages/"),
  );
}

function where(symbol: import("typescript").Symbol): string {
  const decl = symbol.declarations?.[0];
  if (!decl) return symbol.getName();
  const file = decl.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(decl.getStart());
  return `${file.fileName.replace(process.cwd() + "/", "")}:${line + 1}`;
}

function visit(symbol: import("typescript").Symbol, name: string): void {
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (seen.has(symbol)) return;
  seen.add(symbol);
  if (!documented(symbol)) undocumented.add(`${where(symbol)}: ${name}`);

  const isContainer =
    symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum);
  if (!isContainer) return;
  for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
    const decl = member.valueDeclaration ?? member.declarations?.[0];
    if (!decl) continue;
    const modifiers = ts.getCombinedModifierFlags(decl as import("typescript").Declaration);
    if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    if (member.getName().startsWith("__") || member.getName().startsWith("#")) continue;
    if (!documented(member)) undocumented.add(`${where(member)}: ${name}.${member.getName()}`);
  }
}

for (const entry of entries) {
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`cannot read ${entry}; run pnpm build first`);
  for (const exported of checker.getExportsOfModule(moduleSymbol))
    visit(exported, exported.getName());
}

for (const line of [...undocumented].sort()) console.log(line);
if (undocumented.size > 0) {
  console.log(`\n${undocumented.size} exported symbols have no doc comment.`);
  process.exit(1);
}
console.log("Every exported symbol is documented.");
