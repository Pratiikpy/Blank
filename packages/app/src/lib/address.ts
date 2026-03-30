export function truncateAddress(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (!addr || addr.length < prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}
