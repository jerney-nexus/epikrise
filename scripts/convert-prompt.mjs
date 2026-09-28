import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const maxTemplateBytes = 1_048_576;

function usage() {
  return `Usage: npm run template:convert -- <prompt.txt> <output.epitpl> [options]

Options:
  --name <name>          Template display name
  --locale <locale>      Locale for section labels (default: de-CH)
  --author <author>      Template author (default: Local import)
  --section <id=label>   Add an enabled section; repeat as needed
  --force                Replace an existing output file
  --help                 Show this help`;
}

function parseArguments(args) {
  const positional = [];
  const options = {
    name: "Imported clinical prompt",
    locale: "de-CH",
    author: "Local import",
    sections: [],
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") return { help: true };
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (["--name", "--locale", "--author", "--section"].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === "--section") {
        const separator = value.indexOf("=");
        if (separator < 1 || separator === value.length - 1) {
          throw new Error("Sections must use the form id=label");
        }
        const id = value.slice(0, separator).trim();
        const label = value.slice(separator + 1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) || !label) {
          throw new Error(`Invalid section definition: ${value}`);
        }
        options.sections.push({ id, label });
      } else {
        options[argument.slice(2)] = value;
      }
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }

  if (positional.length !== 2) throw new Error(usage());
  return { inputPath: positional[0], outputPath: positional[1], options };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { inputPath, outputPath, options } = parsed;
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("Input and output paths must be different");
  }
  if (!outputPath.toLowerCase().endsWith(".epitpl")) {
    throw new Error("Output files must use the .epitpl extension");
  }
  const sourceBytes = await readFile(inputPath);
  if (sourceBytes.byteLength > maxTemplateBytes) {
    throw new Error("Prompt files must be 1 MiB or smaller");
  }

  const systemPrompt = new TextDecoder("utf-8", { fatal: true })
    .decode(sourceBytes)
    .replace(/^\uFEFF/, "");
  if (!systemPrompt.trim()) throw new Error("The prompt file is empty");
  if (/\{\{|\{%/.test(systemPrompt)) {
    throw new Error(
      "Template expressions require declared variables; convert this prompt manually",
    );
  }

  const sections = options.sections.length
    ? options.sections
    : [
        {
          id: "summary",
          label: options.locale === "de-CH" ? "Zusammenfassung" : "Summary",
        },
      ];
  if (new Set(sections.map(({ id }) => id)).size !== sections.length) {
    throw new Error("Section IDs must be unique");
  }

  const templateId =
    options.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "imported-prompt";
  const template = {
    schema_version: 1,
    metadata: {
      id: templateId,
      name: options.name,
      description: `Converted from ${path.basename(inputPath)}`,
      locale: options.locale,
      specialty_tags: [],
      version: "1.0.0",
      author: options.author,
    },
    system_prompt: systemPrompt,
    variables: [],
    sections: sections.map(({ id, label }, order) => ({
      id,
      heading: label,
      order,
      enabled_by_default: true,
      labels: { [options.locale]: label },
    })),
    output_rules: {
      forbidden_terms: [
        "ß",
        "St.n.",
        "Status nach",
        "Antibiose",
        "Erstdiagnose",
        "TTE",
      ],
      required_terms: [],
      forbid_code_fences: true,
      forbid_leading_whitespace: true,
    },
  };
  const serialized = `${JSON.stringify(template, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxTemplateBytes) {
    throw new Error("The converted template exceeds the 1 MiB import limit");
  }

  await writeFile(outputPath, serialized, { flag: options.force ? "w" : "wx" });
  process.stdout.write(`Wrote ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
