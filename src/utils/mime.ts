const MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif',
  mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime',
  webm: 'video/webm', m4v: 'video/x-m4v', mpg: 'video/mpeg', mpeg: 'video/mpeg', m2ts: 'video/mp2t', mts: 'video/mp2t',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz', zst: 'application/zstd',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', rtf: 'application/rtf',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  ts: 'text/typescript', json: 'application/json', xml: 'application/xml', yml: 'application/yaml', yaml: 'application/yaml',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java',
  sh: 'application/x-sh', sql: 'application/sql', ipynb: 'application/x-ipynb+json',
  exe: 'application/x-msdownload', msi: 'application/x-msi', apk: 'application/vnd.android.package-archive',
  ipa: 'application/octet-stream', dmg: 'application/x-apple-diskimage', deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm', appimage: 'application/x-executable', jar: 'application/java-archive',
  epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook', iso: 'application/x-iso9660-image',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

export function guessMime(fileName: string, provided?: string | null): string {
  if (provided && provided !== 'application/octet-stream' && provided.includes('/')) return provided;
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return MAP[ext] ?? provided ?? 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return /^image\//.test(mime);
}
