import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targetSpecifications = {
  "x86_64-unknown-linux-gnu": { format: "ELF", architecture: "x86_64" },
  "aarch64-unknown-linux-gnu": { format: "ELF", architecture: "aarch64" },
  "x86_64-apple-darwin": { format: "Mach-O", architecture: "x86_64" },
  "aarch64-apple-darwin": { format: "Mach-O", architecture: "arm64" },
  "x86_64-pc-windows-msvc": { format: "PE", architecture: "x86_64" },
  "aarch64-pc-windows-msvc": { format: "PE", architecture: "arm64" },
};

const architectureNames = {
  0x01000007: "x86_64",
  0x0100000c: "arm64",
};

const peMachineNames = {
  0x8664: "x86_64",
  0xaa64: "arm64",
};

const elfMachineNames = {
  62: "x86_64",
  183: "aarch64",
};

function parseMachOArchitecture(binary, offset, littleEndian) {
  if (offset + 8 > binary.length) throw new Error("truncated Mach-O header");
  const cpuType = littleEndian
    ? binary.readUInt32LE(offset + 4)
    : binary.readUInt32BE(offset + 4);
  return architectureNames[cpuType] ?? `unknown (0x${cpuType.toString(16)})`;
}

function inspectMachO(binary) {
  const magic = binary.subarray(0, 4).toString("hex");
  const thinFormats = {
    feedface: { littleEndian: false },
    cefaedfe: { littleEndian: true },
    feedfacf: { littleEndian: false },
    cffaedfe: { littleEndian: true },
  };
  if (thinFormats[magic]) {
    return [parseMachOArchitecture(binary, 0, thinFormats[magic].littleEndian)];
  }

  const fatFormats = {
    cafebabe: { littleEndian: false, is64Bit: false },
    bebafeca: { littleEndian: true, is64Bit: false },
    cafebabf: { littleEndian: false, is64Bit: true },
    bfbafeca: { littleEndian: true, is64Bit: true },
  };
  const fatFormat = fatFormats[magic];
  if (!fatFormat) return undefined;
  if (binary.length < 8) throw new Error("truncated universal Mach-O header");

  const readUInt32 = fatFormat.littleEndian
    ? binary.readUInt32LE.bind(binary)
    : binary.readUInt32BE.bind(binary);
  const architectureCount = readUInt32(4);
  const recordSize = fatFormat.is64Bit ? 32 : 20;
  if (8 + architectureCount * recordSize > binary.length) {
    throw new Error("truncated universal Mach-O architecture table");
  }

  return Array.from({ length: architectureCount }, (_, index) =>
    parseMachOArchitecture(binary, 8 + index * recordSize, fatFormat.littleEndian),
  );
}

function inspectBinaryArchitecture(binary) {
  if (binary.length >= 64 && binary.subarray(0, 2).toString() === "MZ") {
    const peOffset = binary.readUInt32LE(0x3c);
    if (
      peOffset + 6 > binary.length ||
      binary.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
    ) {
      throw new Error("invalid or truncated PE header");
    }
    const machine = binary.readUInt16LE(peOffset + 4);
    return {
      format: "PE",
      architectures: [peMachineNames[machine] ?? `unknown (0x${machine.toString(16)})`],
    };
  }

  if (
    binary.length >= 20 &&
    binary[0] === 0x7f &&
    binary.toString("ascii", 1, 4) === "ELF"
  ) {
    const byteOrder = binary[5];
    if (byteOrder !== 1 && byteOrder !== 2) {
      throw new Error("invalid ELF byte order");
    }
    const machine = byteOrder === 1 ? binary.readUInt16LE(18) : binary.readUInt16BE(18);
    return {
      format: "ELF",
      architectures: [elfMachineNames[machine] ?? `unknown (${machine})`],
    };
  }

  const machOArchitectures = inspectMachO(binary);
  if (machOArchitectures)
    return { format: "Mach-O", architectures: machOArchitectures };

  throw new Error("unrecognized executable format");
}

export async function verifyBinaryArchitecture(target, filePath) {
  const specification = targetSpecifications[target];
  if (!specification) throw new Error(`Unsupported binary target: ${target}`);

  let inspected;
  try {
    inspected = inspectBinaryArchitecture(await readFile(filePath));
  } catch (error) {
    throw new Error(`Could not verify binary ${filePath}: ${error.message}`, {
      cause: error,
    });
  }

  if (
    inspected.format !== specification.format ||
    !inspected.architectures.includes(specification.architecture)
  ) {
    throw new Error(
      `Binary architecture mismatch for ${filePath}: target ${target} expects ${specification.format} ${specification.architecture}; found ${inspected.format} ${inspected.architectures.join(", ")}.`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [target, filePath, ...extraArgs] = process.argv.slice(2);
  if (!target || !filePath || extraArgs.length > 0) {
    console.error(
      `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <target> <binary>`,
    );
    process.exitCode = 2;
  } else {
    try {
      await verifyBinaryArchitecture(target, filePath);
      console.log(`Verified ${target} binary architecture: ${filePath}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
