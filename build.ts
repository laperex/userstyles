#!/usr/bin/env -S deno run -A
import less from "less";
import usercssMeta from "usercss-meta";
import { parse as parseArgs } from "std/flags/mod.ts";
import { walk } from "std/fs/walk.ts";
import { basename, dirname, join, resolve } from "std/path/mod.ts";

// =============================================================================
// CLI args
// =============================================================================

const args = parseArgs(Deno.args, {
  string: ["style-dir", "out-dir"],
  alias: { s: "style-dir", o: "out-dir" },
  default: { "style-dir": "styles", "out-dir": "compiled" },
});

// Resolve paths relative to CWD of the caller, not the script location.
const STYLE_DIR = resolve(Deno.cwd(), args["style-dir"]);
const OUT_DIR   = resolve(Deno.cwd(), args["out-dir"]);

// =============================================================================
// CSS Filter Solver
// =============================================================================

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class Color {
  r: number; g: number; b: number;

  constructor(r: number, g: number, b: number) {
    this.r = r; this.g = g; this.b = b;
  }

  hsl(): [number, number, number] {
    const r = this.r / 255, g = this.g / 255, b = this.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
    return [h * 360, s * 100, l * 100];
  }

  applyFilters(filters: number[]): Color {
    // filters: [invert, sepia, saturate, hueRotate, brightness, contrast]
    let [r, g, b] = [this.r / 255, this.g / 255, this.b / 255];

    // invert
    const inv = filters[0] / 100;
    r = r + inv * (1 - 2 * r);
    g = g + inv * (1 - 2 * g);
    b = b + inv * (1 - 2 * b);

    // sepia
    const sep = filters[1] / 100;
    const nr = r * (1 - 0.607 * sep) + g * 0.769 * sep + b * 0.189 * sep;
    const ng = r * 0.349 * sep + g * (1 - 0.314 * sep) + b * 0.168 * sep;
    const nb = r * 0.272 * sep + g * 0.534 * sep + b * (1 - 0.869 * sep);
    r = nr; g = ng; b = nb;

    // saturate
    const sat = filters[2] / 100;
    const lumR = 0.213, lumG = 0.715, lumB = 0.072;
    r = Math.min(1, r * (lumR * (1 - sat) + sat) + g * lumG * (1 - sat) + b * lumB * (1 - sat));
    g = Math.min(1, r * lumR * (1 - sat) + g * (lumG * (1 - sat) + sat) + b * lumB * (1 - sat));
    b = Math.min(1, r * lumR * (1 - sat) + g * lumG * (1 - sat) + b * (lumB * (1 - sat) + sat));

    // hue-rotate
    const angle = filters[3] * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const nr2 = r * (lumR + cos * (1 - lumR) + sin * -lumR)         + g * (lumG + cos * -lumG        + sin * -lumG)        + b * (lumB + cos * -lumB        + sin * (1 - lumB));
    const ng2 = r * (lumR + cos * -lumR       + sin * 0.143)         + g * (lumG + cos * (1 - lumG)   + sin * 0.140)        + b * (lumB + cos * -lumB        + sin * -0.283);
    const nb2 = r * (lumR + cos * -lumR       + sin * -(1 - lumR))   + g * (lumG + cos * -lumG        + sin * lumG)         + b * (lumB + cos * (1 - lumB)   + sin * lumB);
    r = Math.min(1, Math.max(0, nr2));
    g = Math.min(1, Math.max(0, ng2));
    b = Math.min(1, Math.max(0, nb2));

    // brightness
    const bri = filters[4] / 100;
    r = Math.min(1, r * bri); g = Math.min(1, g * bri); b = Math.min(1, b * bri);

    // contrast
    const con = filters[5] / 100;
    r = Math.min(1, Math.max(0, con * (r - 0.5) + 0.5));
    g = Math.min(1, Math.max(0, con * (g - 0.5) + 0.5));
    b = Math.min(1, Math.max(0, con * (b - 0.5) + 0.5));

    return new Color(r * 255, g * 255, b * 255);
  }

  loss(target: Color): number {
    return (
      Math.abs(this.r - target.r) +
      Math.abs(this.g - target.g) +
      Math.abs(this.b - target.b)
    );
  }
}

function solveFilter(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const target = new Color(r, g, b);

  let best: number[] = [];
  let bestLoss = Infinity;

  for (let attempt = 0; attempt < 50; attempt++) {
    const filters = [
      Math.random() * 100,  // invert
      Math.random() * 100,  // sepia
      Math.random() * 700,  // saturate
      Math.random() * 360,  // hue-rotate
      Math.random() * 200,  // brightness
      Math.random() * 200,  // contrast
    ];

    let stepSize = 1;
    for (let iter = 0; iter < 500; iter++) {
      for (let i = 0; i < filters.length; i++) {
        for (const delta of [-stepSize, stepSize]) {
          const candidate = [...filters];
          candidate[i] = Math.max(0, filters[i] + delta);
          if (i === 3) candidate[i] = candidate[i] % 360;

          const result = new Color(0, 0, 0).applyFilters(candidate);
          const loss = result.loss(target);
          if (loss < bestLoss) {
            best = [...candidate];
            bestLoss = loss;
            filters[i] = candidate[i];
          }
        }
      }
      stepSize *= 0.98;
      if (bestLoss < 1) break;
    }
    if (bestLoss < 1) break;
  }

  const [inv, sep, sat, hue, bri, con] = best.map(Math.round);
  return [
    `brightness(0) saturate(100%)`,
    `invert(${inv}%)`,
    `sepia(${sep}%)`,
    `saturate(${sat}%)`,
    `hue-rotate(${hue}deg)`,
    `brightness(${bri}%)`,
    `contrast(${con}%)`,
  ].join(" ");
}

// =============================================================================
// CSS Post-processing
// =============================================================================

/** Append !important to every declaration that doesn't already have it. */
function addImportant(css: string): string {
  return css.replace(/:\s*([^;{}]+?)\s*(!important)?\s*;/g, (match, _value, imp) => {
    if (imp) return match;
    return match.replace(/\s*;$/, " !important;");
  });
}

// =============================================================================
// CSS Validator
// =============================================================================

interface CssIssue {
  level: "ERROR" | "WARN";
  msg: string;
}

/**
 * Known-harmless warnings that are intentional in catppuccin userstyles
 * compiled for Firefox userContent.css. Listed here to suppress noise.
 */
const SUPPRESSED_WARN_PATTERNS: RegExp[] = [
  // webkit date/time pseudo-elements — intentionally kept for Chrome compat,
  // silently ignored by Firefox.
  /::-webkit-datetime-edit/,
];

function validateCss(css: string): CssIssue[] {
  const issues: CssIssue[] = [];

  // 1. Balanced braces
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) {
      issues.push({ level: "ERROR", msg: "Unexpected } (unbalanced braces)" });
      break;
    }
  }
  if (depth !== 0)
    issues.push({ level: "ERROR", msg: `Unbalanced braces (depth=${depth} at EOF)` });

  // 2. Unclosed block comments
  const opens  = (css.match(/\/\*/g)  ?? []).length;
  const closes = (css.match(/\*\//g) ?? []).length;
  if (opens !== closes)
    issues.push({ level: "ERROR", msg: `Unclosed block comment (/* ×${opens} vs */ ×${closes})` });

  // 3. Double !important (produced by a bug in addImportant)
  if (css.includes("!important !important"))
    issues.push({ level: "ERROR", msg: "Double !important detected" });

  // 4. -webkit- pseudo-elements (no-op in Firefox)
  const webkitHits = css.match(/::-webkit-[\w-]+/g);
  if (webkitHits) {
    const unique = [...new Set(webkitHits)];
    const unsuppressed = unique.filter(
      (u) => !SUPPRESSED_WARN_PATTERNS.some((p) => p.test(u)),
    );
    if (unsuppressed.length > 0)
      issues.push({ level: "WARN", msg: `Firefox-incompatible -webkit- pseudo-elements: ${unsuppressed.join(", ")}` });
  }

  // 5. Decimal values inside rgb() — invalid per CSS spec
  const badRgb = css.match(/\brgb\([^)]*\d+\.\d+[^)]*\)/g);
  if (badRgb) {
    const unique = [...new Set(badRgb)];
    issues.push({ level: "WARN", msg: `Decimal values inside rgb() (invalid): ${unique.slice(0, 3).join(", ")}` });
  }

  // 6. Empty rulesets
  const empty = css.match(/\{\s*\}/g);
  if (empty)
    issues.push({ level: "WARN", msg: `${empty.length} empty ruleset(s)` });

  return issues;
}

// =============================================================================
// Usercss-meta helpers
// =============================================================================

function extractVarDefaults(src: string): Record<string, string> {
  try {
    const { metadata } = usercssMeta.parse(src, { mandatoryKeys: [] });
    const defaults: Record<string, string> = {};
    for (const [name, variable] of Object.entries(metadata.vars ?? {})) {
      const v = variable as Record<string, unknown>;
      const type = v.type as string;
      const defaultVal = v.default;
      if (defaultVal === undefined || defaultVal === null) continue;
      if (type === "select" || type === "dropdown") defaults[name] = `"${defaultVal}"`;
      else if (type === "checkbox")                 defaults[name] = String(defaultVal);
      else if (type === "color")                    defaults[name] = `"${defaultVal}"`;
      else if (type === "text")                     defaults[name] = `"${defaultVal}"`;
      else if (type === "number" || type === "range") defaults[name] = String(defaultVal);
    }
    return defaults;
  } catch {
    return {};
  }
}

// =============================================================================
// Main
// =============================================================================

const CUSTOM_ACCENT = "#c19fec";

const CUSTOM_ACCENT_FILTER = solveFilter(CUSTOM_ACCENT);

console.log(`Style dir:    ${STYLE_DIR}`);
console.log(`Output dir:   ${OUT_DIR}`);
console.log(`Accent filter: ${CUSTOM_ACCENT_FILTER}\n`);

const FLAVORS = ["mocha"] as const;
await Deno.mkdir(OUT_DIR, { recursive: true });

let ok = 0, fail = 0;

const compiledPath = join(STYLE_DIR, "compiled.css");

var full_css = ""

for await (const entry of walk(STYLE_DIR, { match: [/catppuccin\.user\.less$/] })) {
  const styleName = basename(dirname(entry.path));
  const src = await Deno.readTextFile(entry.path);
  const varDefaults = extractVarDefaults(src);

  for (const flavor of FLAVORS) {
    const outPath = join(OUT_DIR, `${styleName}.css`);

    const modifyVars: Record<string, string> = {
      ...varDefaults,
      flavor:           `"${flavor}"`,
      accentColor:      `"mauve"`,
      darkFlavor:       `"${flavor}"`,
      lightFlavor:      `"latte"`,
      "custom-accent":           CUSTOM_ACCENT,
      "custom-accent-filter":  `"${CUSTOM_ACCENT_FILTER}"`,
    };

    try {
      const result = await less.render(src, { modifyVars, javascriptEnabled: true });

      const css = addImportant(
        result.css
          .replace(/\/\*\s*==UserStyle==[\s\S]*?==\/UserStyle==\s*\*\//g, "")
          .trimStart(),
      );

      // --- Validate ---
      const issues = validateCss(css);
      const errors = issues.filter((i) => i.level === "ERROR");
      const warns  = issues.filter((i) => i.level === "WARN");

      for (const w of warns)
        console.warn(`  %cWARN%c [${styleName}/${flavor}] ${w.msg}`, "color:yellow", "color:reset");
      for (const e of errors)
        console.error(`  %cERROR%c [${styleName}/${flavor}] ${e.msg}`, "color:red", "color:reset");

      if (errors.length > 0) {
        console.log(`%c✗%c ${styleName} [${flavor}/custom]: validation failed, skipping write`, "color:red", "color:reset");
        fail++;
        continue;
      }

      await Deno.writeTextFile(outPath, css);

      full_css += css;

      const warnSuffix = warns.length ? ` (${warns.length} warning${warns.length > 1 ? "s" : ""})` : "";
      console.log(`%c✓%c ${styleName} [${flavor}/custom]${warnSuffix}`, "color:green", "color:reset");
      ok++;
    } catch (e) {
      console.warn(
        `%c✗%c ${styleName} [${flavor}/custom]: ${(e as Error).message.split("\n")[0]}`,
        "color:red", "color:reset",
      );
      fail++;
    }
  }

  await Deno.writeTextFile(compiledPath, full_css);
}

console.log(`\nDone: ${ok} compiled, ${fail} failed → ${OUT_DIR}/`);