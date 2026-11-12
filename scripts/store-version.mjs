// Dependency-free CalVer and Microsoft Store version helpers. Kept separate from
// prepare-release.mjs so CI steps that run without installed packages can use them.

const calverPattern = /^(\d{4})\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/;

/** @param {string} version */
export function validateCalverVersion(version) {
  if (!calverPattern.test(version)) {
    throw new Error(`Invalid CalVer version: ${version}. Expected YYYY.M.MICRO.`);
  }
  return version;
}

/** @param {string} version */
export function deriveReleaseVersions(version) {
  validateCalverVersion(version);
  const [yearText, monthText, patchText] = version.split(".");
  const year = Number(yearText);
  const month = Number(monthText);
  const patch = BigInt(patchText);

  if (year < 2000) {
    throw new Error("Release year must be at least 2000.");
  }
  if (patch > 65535n) {
    throw new Error("Release patch must be at most 65535 for MSIX.");
  }

  return {
    releaseVersion: version,
    updateProtocolVersion: `${year}.${month}.${patch}`,
    msixIdentityVersion: `${year}.${month}.${patch}.0`,
  };
}

/** @param {string} version */
export function releaseVersionFromProtocolVersion(version) {
  const match = calverPattern.exec(version);
  if (!match) throw new Error(`Invalid update protocol version: ${version}.`);
  const releaseVersion = version;
  deriveReleaseVersions(releaseVersion);
  return releaseVersion;
}

/** @param {string} releaseVersion @param {string} publishedStoreVersion */
export function assertStoreVersionAdvances(releaseVersion, publishedStoreVersion) {
  const next = deriveReleaseVersions(releaseVersion).msixIdentityVersion;
  const published = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(publishedStoreVersion);
  if (!published || published.slice(1).some((part) => BigInt(part) > 65535n)) {
    throw new Error(`Invalid published Store version: ${publishedStoreVersion}.`);
  }
  const nextParts = next.split(".").map(BigInt);
  const publishedParts = published.slice(1).map(BigInt);
  const comparison = nextParts.findIndex(
    (part, index) => part !== publishedParts[index],
  );
  if (comparison < 0 || nextParts[comparison] < publishedParts[comparison]) {
    throw new Error(
      `Store version ${next} must be greater than ${publishedStoreVersion}.`,
    );
  }
  return next;
}
