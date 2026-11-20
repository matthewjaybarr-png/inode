// Small line icons drawn here (24-unit grid, stroke = currentColor), so they follow the theme and need no icon font.
import { extOf } from './util.js';

const PAGE = 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5';
const SCREEN = 'M3 4h18v12H3zM8 20h8M12 16v4';
const PATHS = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  file: PAGE,
  doc: `${PAGE}M8 13h8M8 17h8M8 9h2`,
  pdf: `${PAGE}M8 13h5M8 17h8`,
  sheet: `${PAGE}M8 12h8v6H8zM12 12v6M8 15h8`,
  slides: `${PAGE}M8 12h8v5H8z`,
  image: 'M4 5h16v14H4zM20 15l-5-5L5 19M8.5 7.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  audio: 'M9 18V5l11-2v13M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6M17 13a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  archive: 'M2 3h20v4H2zM3 7h18v13H3zM10 11h4',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  app: 'M4 4h16v16H4zM4 9h16',
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6',
  desktop: SCREEN,
  computer: SCREEN,
  downloads: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M15.5 15.5L20 20',
  drive: 'M3 13h18v6H3zM3 13l3-8h12l3 8M17 16h.01',
  eject: 'M12 5l7 8H5zM5 17h14v2H5z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  recent: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  network: 'M4 4h16v8H4zM12 12v5M5 19h14M8 8h.01',
  connect: 'M12 5v14M5 12h14',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  locked: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
};
// Sidebar place kinds that draw like a file type.
const PLACE = { documents: 'doc', pictures: 'image', music: 'audio', videos: 'video', pin: 'folder' };

const EXT = {};
for (const [name, list] of Object.entries({
  image: 'png jpg jpeg gif webp bmp svg ico avif tif tiff heic cr2 nef dng raw psd',
  video: 'mp4 mkv mov avi webm wmv m4v mpg mpeg',
  audio: 'mp3 wav flac ogg m4a aac opus wma',
  archive: 'zip 7z rar tar gz tgz bz2 xz zst cab iso',
  code: 'js mjs ts jsx tsx json rs py c h cpp hpp cs java go rb php html css scss sh ps1 bat cmd lua toml yaml yml xml sql nc tap',
  doc: 'txt md log doc docx odt rtf ini cfg conf',
  pdf: 'pdf',
  sheet: 'xls xlsx xlsm xlsb ods csv tsv',
  slides: 'ppt pptx odp',
  app: 'exe msi appimage deb rpm dll lnk desktop',
})) for (const x of list.split(' ')) EXT[x] = name;

// Which icon a file or folder gets; the name doubles as its colour class.
export const iconFor = (name, dir) => (dir ? 'folder' : EXT[extOf(name)] || 'file');

export function icon(name) {
  name = PLACE[name] || name;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ico t-${name}`);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] || PAGE);
  svg.append(p);
  return svg;
}
