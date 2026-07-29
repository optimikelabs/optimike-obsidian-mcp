import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDir = path.join(repoRoot, "docs", "assets", "readme");

const C = {
  paper: "#F7F5F0",
  ink: "#1A1A1A",
  surface: "#EFEDE8",
  border: "#E0DCD4",
  copper: "#B87333",
  blue: "#2E5A7C",
  green: "#4A7C59",
  bench: "#131316",
};

const copy = {
  en: {
    eyebrow: "OPTIMIKE · OBSIDIAN MCP",
    overview: {
      number: "01",
      title: "One runtime, two ways in",
      subtitle: "Local speed by stdio. Controlled reach by HTTP.",
      local: "LOCAL CLIENT",
      remote: "REMOTE CLIENT",
      stdio: "stdio proxy",
      http: "HTTP · pilot",
      runtime: "Persistent MCP runtime",
      gateway: "Governed access plane",
      obsidian: "Obsidian + bridges",
      roots: "External roots",
      note: "Read-only handoff",
      localMove: "Local move · gated",
      path: "local_path",
      ticket: "http_ticket",
    },
    documentationHub: {
      number: "02",
      title: "Documentation, routed by intent",
      subtitle: "Start with the question. Land in the right contract.",
      start: "START HERE",
      learn: "UNDERSTAND",
      run: "OPERATE",
      protect: "PROTECT",
      overview: "Overview",
      profiles: "Runtime profiles",
      routing: "Routing guide",
      operations: "Operations",
      security: "Security",
      roots: "External roots",
      note: "Six focused guides · one runtime truth",
    },
    operations: {
      number: "03",
      title: "Operate the persistent core",
      subtitle: "Keep client processes light. Observe one long-lived runtime.",
      client: "CLIENT",
      proxy: "Short-lived stdio proxy",
      core: "PERSISTENT CORE",
      runtime: "HTTP MCP runtime",
      source: "SOURCE",
      obsidian: "Obsidian / synchronized vault",
      checks: "OPERATIONS LOOP",
      c1: "Start",
      c2: "Check readiness",
      c3: "Watch provenance",
      c4: "Bound sessions",
      result: "Heavy state is built once",
    },
    security: {
      number: "04",
      title: "Access is explicit, mutation is narrower",
      subtitle:
        "Identity shapes the access plane. Tool policy controls effect.",
      local: "LOCAL STDIO",
      localTrust: "Trusted machine",
      remote: "REMOTE HTTP",
      pilot: "Pilot only",
      optionalGateway: "optional gateway",
      controlPlane: "CONTROL PLANE",
      policy: "MCP policy",
      controls: "identity · scopes · limits",
      readonly: "READ-ONLY HANDOFF",
      handoff: "local_path / http_ticket",
      mutation: "EXTERNAL MOVE",
      move: "stdio + headless-filesystem",
      gates: "gates · CAS · journal · rollback",
      deny: "Remote HTTP cannot move external files",
    },
    runtimeProfiles: {
      number: "05",
      title: "Choose the source before the profile",
      subtitle: "Profiles define provenance, availability and write policy.",
      live: "LIVE",
      liveSource: "Obsidian Desktop",
      liveDetail: "Local REST API required",
      hybrid: "HYBRID",
      hybridSource: "API or filesystem",
      hybridDetail: "Fallback stays available",
      headless: "HEADLESS",
      headlessSource: "Synchronized vault",
      headlessDetail: "Readonly → guarded → filesystem",
      bridge: "BRIDGES",
      bridgeDetail: "Desktop-only semantics",
      rule: "Server default: begin readonly",
    },
    routingGuide: {
      number: "06",
      title: "Route by effect, not by convenience",
      subtitle: "The safest valid path depends on what must happen.",
      ask: "WHAT DO YOU NEED?",
      vault: "Vault knowledge",
      external: "External file",
      read: "Read / search",
      externalRead: "List / read",
      handoff: "Temporary copy",
      move: "Move + repair links",
      any: "stdio or HTTP",
      local: "stdio → local_path",
      remote: "HTTP → http_ticket",
      gated: "stdio + headless-filesystem",
      controls: "gates · CAS · journal · rollback",
      boundary:
        "Reads and handoff stay default-deny; move requires explicit gates",
    },
  },
  fr: {
    eyebrow: "OPTIMIKE · OBSIDIAN MCP",
    overview: {
      number: "01",
      title: "Un runtime, deux accès",
      subtitle: "La vitesse locale par stdio. La portée contrôlée par HTTP.",
      local: "CLIENT LOCAL",
      remote: "CLIENT DISTANT",
      stdio: "proxy stdio",
      http: "HTTP · pilote",
      runtime: "Runtime MCP persistant",
      gateway: "Plan d’accès gouverné",
      obsidian: "Obsidian + bridges",
      roots: "Racines externes",
      note: "Handoff en lecture seule",
      localMove: "Move local · gates",
      path: "local_path",
      ticket: "http_ticket",
    },
    documentationHub: {
      number: "02",
      title: "La documentation suit l’intention",
      subtitle: "Partez de la question. Arrivez au bon contrat.",
      start: "POINT DE DÉPART",
      learn: "COMPRENDRE",
      run: "OPÉRER",
      protect: "PROTÉGER",
      overview: "Vue d’ensemble",
      profiles: "Profils runtime",
      routing: "Guide de routage",
      operations: "Opérations",
      security: "Sécurité",
      roots: "Racines externes",
      note: "Six guides ciblés · une seule vérité runtime",
    },
    operations: {
      number: "03",
      title: "Opérer le cœur persistant",
      subtitle: "Des clients légers. Un runtime durable à observer.",
      client: "CLIENT",
      proxy: "Proxy stdio éphémère",
      core: "CŒUR PERSISTANT",
      runtime: "Runtime MCP HTTP",
      source: "SOURCE",
      obsidian: "Obsidian / coffre synchronisé",
      checks: "BOUCLE D’EXPLOITATION",
      c1: "Démarrer",
      c2: "Vérifier readiness",
      c3: "Suivre la provenance",
      c4: "Borner les sessions",
      result: "L’état lourd n’est construit qu’une fois",
    },
    security: {
      number: "04",
      title: "L’accès est explicite, la mutation plus étroite",
      subtitle:
        "L’identité structure le plan d’accès. La politique outil contrôle l’effet.",
      local: "STDIO LOCAL",
      localTrust: "Machine de confiance",
      remote: "HTTP DISTANT",
      pilot: "Pilote uniquement",
      optionalGateway: "gateway optionnelle",
      controlPlane: "PLAN DE CONTRÔLE",
      policy: "Politique MCP",
      controls: "identité · scopes · limites",
      readonly: "HANDOFF EN LECTURE SEULE",
      handoff: "local_path / http_ticket",
      mutation: "DÉPLACEMENT EXTERNE",
      move: "stdio + headless-filesystem",
      gates: "gates · CAS · journal · rollback",
      deny: "HTTP distant ne déplace aucun fichier externe",
    },
    runtimeProfiles: {
      number: "05",
      title: "Choisir la source avant le profil",
      subtitle:
        "Le profil fixe provenance, disponibilité et politique d’écriture.",
      live: "LIVE",
      liveSource: "Obsidian Desktop",
      liveDetail: "Local REST API requise",
      hybrid: "HYBRID",
      hybridSource: "API ou filesystem",
      hybridDetail: "Le fallback reste disponible",
      headless: "HEADLESS",
      headlessSource: "Coffre synchronisé",
      headlessDetail: "Readonly → guarded → filesystem",
      bridge: "BRIDGES",
      bridgeDetail: "Sémantique Desktop uniquement",
      rule: "Serveur : commencer en lecture seule",
    },
    routingGuide: {
      number: "06",
      title: "Router par effet, pas par confort",
      subtitle: "Le chemin valide le plus sûr dépend de l’action attendue.",
      ask: "QUEL EST LE BESOIN ?",
      vault: "Connaissance du coffre",
      external: "Fichier externe",
      read: "Lire / chercher",
      externalRead: "Lister / lire",
      handoff: "Copie temporaire",
      move: "Déplacer + réparer les liens",
      any: "stdio ou HTTP",
      local: "stdio → local_path",
      remote: "HTTP → http_ticket",
      gated: "stdio + headless-filesystem",
      controls: "gates · CAS · journal · rollback",
      boundary:
        "Lectures et handoff restent deny-by-default ; move exige des gates explicites",
    },
  },
};

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const text = (x, y, value, cls = "body", anchor = "start") =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(value)}</text>`;

const lineText = (x, y, lines, cls = "body", gap = 24, anchor = "start") =>
  lines
    .map((value, index) => text(x, y + index * gap, value, cls, anchor))
    .join("\n");

const rect = (x, y, width, height, options = {}) => {
  const {
    fill = C.surface,
    stroke = C.border,
    radius = 18,
    strokeWidth = 2,
  } = options;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
};

const pill = (x, y, width, label, fill = C.surface, color = C.ink) =>
  `${rect(x, y, width, 34, { fill, stroke: fill, radius: 17, strokeWidth: 0 })}
  <text x="${x + width / 2}" y="${y + 22}" class="pill" fill="${color}" text-anchor="middle">${esc(label)}</text>`;

const arrow = (x1, y1, x2, y2, color = C.copper, dashed = false) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3"${dashed ? ' stroke-dasharray="7 7"' : ""} marker-end="url(#arrow)"/>`;

const base = (lang, topic, body) => {
  const d = copy[lang][topic];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">${esc(d.title)}</title>
  <desc id="description">${esc(d.subtitle)}</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.copper}"/>
    </marker>
  </defs>
  <style>
    .eyebrow,.meta,.pill{font-family:"JetBrains Mono","SFMono-Regular",Consolas,monospace;font-weight:700;letter-spacing:1.2px}
    .title{font-family:Newsreader,Georgia,serif;font-size:45px;font-weight:700;fill:${C.ink}}
    .sectionTitle{font-family:Newsreader,Georgia,serif;font-size:34px;font-weight:700;fill:${C.paper}}
    .subtitle{font-family:"DM Sans",Inter,Arial,sans-serif;font-size:19px;fill:${C.blue}}
    .eyebrow{font-size:14px;fill:${C.copper}}
    .meta{font-size:13px;fill:${C.blue}}
    .label{font-family:"DM Sans",Inter,Arial,sans-serif;font-size:18px;font-weight:700;fill:${C.ink}}
    .body{font-family:"DM Sans",Inter,Arial,sans-serif;font-size:17px;fill:${C.ink}}
    .small{font-family:"DM Sans",Inter,Arial,sans-serif;font-size:15px;fill:${C.blue}}
    .pill{font-size:12px}
    .inverse{fill:${C.paper}}
    .accent{fill:${C.copper}}
    .positive{fill:${C.green}}
  </style>
  <rect width="1200" height="630" fill="${C.paper}"/>
  <rect x="0" y="0" width="16" height="630" fill="${C.copper}"/>
  ${text(54, 40, copy[lang].eyebrow, "eyebrow")}
  ${text(1148, 40, d.number, "eyebrow", "end")}
  ${text(54, 92, d.title, "title")}
  ${text(54, 122, d.subtitle, "subtitle")}
  ${body}
  <line x1="54" y1="590" x2="1148" y2="590" stroke="${C.border}" stroke-width="2"/>
  ${text(54, 614, "optimike-obsidian-mcp", "meta")}
  ${text(1148, 614, lang.toUpperCase(), "meta", "end")}
</svg>
`;
};

function overview(lang) {
  const d = copy[lang].overview;
  const runtimeLines =
    lang === "fr"
      ? ["Runtime MCP", "persistant"]
      : ["Persistent MCP", "runtime"];
  const body = `
  ${rect(54, 160, 230, 112)}
  ${text(76, 188, d.local, "meta")}
  ${text(76, 226, d.stdio, "label")}
  ${pill(76, 238, 112, d.path, C.blue, C.paper)}
  ${rect(54, 318, 230, 112)}
  ${text(76, 346, d.remote, "meta")}
  ${text(76, 384, d.http, "label")}
  ${pill(76, 396, 118, d.ticket, C.blue, C.paper)}
  ${arrow(284, 216, 386, 266)}
  ${arrow(284, 374, 386, 318)}
  ${rect(386, 192, 344, 246, { fill: C.bench, stroke: C.bench, radius: 24 })}
  ${text(414, 228, d.gateway, "eyebrow")}
  ${lineText(414, 282, runtimeLines, "sectionTitle", 38)}
  <circle cx="434" cy="356" r="10" fill="${C.green}"/>
  ${text(458, 362, d.note, "inverse")}
  <circle cx="434" cy="392" r="10" fill="${C.copper}"/>
  ${text(458, 398, d.localMove, "inverse")}
  ${arrow(730, 315, 824, 247)}
  ${arrow(730, 315, 824, 383)}
  ${rect(824, 186, 324, 118)}
  ${text(850, 218, "01", "eyebrow")}
  ${text(850, 257, d.obsidian, "label")}
  ${rect(824, 326, 324, 118)}
  ${text(850, 358, "02", "eyebrow")}
  ${text(850, 397, d.roots, "label")}
  ${lineText(850, 423, [d.path + " · " + d.ticket], "small")}`;
  return base(lang, "overview", body);
}

function documentationHub(lang) {
  const d = copy[lang].documentationHub;
  const body = `
  ${rect(54, 158, 1094, 70, { fill: C.bench, stroke: C.bench, radius: 20 })}
  ${text(86, 185, d.start, "eyebrow")}
  ${text(86, 210, d.overview, "label inverse")}
  ${arrow(600, 228, 600, 268)}
  ${text(54, 290, d.learn, "meta")}
  ${text(426, 290, d.run, "meta")}
  ${text(798, 290, d.protect, "meta")}
  ${rect(54, 306, 340, 176)}
  ${rect(426, 306, 340, 176)}
  ${rect(798, 306, 350, 176)}
  ${pill(78, 332, 46, "01", C.copper, C.paper)}
  ${text(78, 396, d.profiles, "label")}
  ${text(78, 430, d.routing, "body")}
  ${pill(450, 332, 46, "02", C.blue, C.paper)}
  ${text(450, 396, d.operations, "label")}
  ${text(450, 430, d.roots, "body")}
  ${pill(822, 332, 46, "03", C.green, C.paper)}
  ${text(822, 396, d.security, "label")}
  ${text(822, 430, d.routing, "body")}
  ${rect(310, 514, 580, 48, { fill: C.paper, stroke: C.border, radius: 24 })}
  ${text(600, 545, d.note, "small", "middle")}`;
  return base(lang, "documentationHub", body);
}

function operations(lang) {
  const d = copy[lang].operations;
  const body = `
  ${text(54, 172, d.client, "meta")}
  ${text(411, 172, d.core, "meta")}
  ${text(830, 172, d.source, "meta")}
  ${rect(54, 190, 284, 106)}
  ${text(78, 232, d.proxy, "label")}
  ${pill(78, 248, 76, "stdio", C.blue, C.paper)}
  ${arrow(338, 243, 411, 243)}
  ${rect(411, 180, 346, 126, { fill: C.bench, stroke: C.bench, radius: 22 })}
  ${text(441, 220, d.runtime, "label inverse")}
  ${pill(441, 246, 72, "HTTP", C.copper, C.paper)}
  ${arrow(757, 243, 830, 243)}
  ${rect(830, 190, 318, 106)}
  ${text(854, 232, d.obsidian, "label")}
  ${pill(854, 248, 118, "API / FILES", C.green, C.paper)}
  ${rect(54, 340, 1094, 190)}
  ${text(82, 374, d.checks, "meta")}
  ${[d.c1, d.c2, d.c3, d.c4]
    .map((label, index) => {
      const x = 82 + index * 252;
      return `${pill(x, 404, 42, String(index + 1).padStart(2, "0"), index === 0 ? C.copper : C.blue, C.paper)}
    ${text(x, 468, label, "label")}
    ${index < 3 ? arrow(x + 154, 422, x + 230, 422, C.copper, true) : ""}`;
    })
    .join("\n")}
  ${text(1120, 510, d.result, "small", "end")}`;
  return base(lang, "operations", body);
}

function security(lang) {
  const d = copy[lang].security;
  const body = `
  ${rect(54, 162, 250, 104)}
  ${text(78, 194, d.local, "meta")}
  ${text(78, 232, d.localTrust, "label")}
  ${rect(54, 292, 250, 104)}
  ${text(78, 324, d.remote, "meta")}
  ${text(78, 362, d.pilot, "label")}
  ${text(78, 388, d.optionalGateway, "small")}
  ${arrow(304, 214, 390, 260)}
  ${arrow(304, 344, 390, 298)}
  ${rect(390, 194, 292, 184, { fill: C.bench, stroke: C.bench, radius: 24 })}
  ${text(420, 228, d.controlPlane, "eyebrow")}
  ${text(420, 274, d.policy, "sectionTitle")}
  ${text(420, 318, d.controls, "inverse")}
  ${arrow(682, 286, 764, 220)}
  ${arrow(682, 286, 764, 354)}
  ${rect(764, 162, 384, 116)}
  ${text(790, 194, d.readonly, "meta")}
  ${text(790, 233, d.handoff, "label")}
  ${rect(764, 304, 384, 116, { fill: C.surface, stroke: C.copper, radius: 18 })}
  ${text(790, 336, d.mutation, "meta")}
  ${text(790, 373, d.move, "label")}
  ${text(790, 399, d.gates, "small")}
  ${rect(390, 458, 758, 64, { fill: C.paper, stroke: C.copper, radius: 18 })}
  <circle cx="424" cy="490" r="11" fill="${C.copper}"/>
  ${text(450, 497, d.deny, "label")}`;
  return base(lang, "security", body);
}

function runtimeProfiles(lang) {
  const d = copy[lang].runtimeProfiles;
  const cards = [
    {
      x: 54,
      name: d.live,
      source: d.liveSource,
      detail: d.liveDetail,
      color: C.copper,
      badge: "API",
    },
    {
      x: 360,
      name: d.hybrid,
      source: d.hybridSource,
      detail: d.hybridDetail,
      color: C.blue,
      badge: "API + FS",
    },
    {
      x: 666,
      name: d.headless,
      source: d.headlessSource,
      detail: d.headlessDetail,
      color: C.green,
      badge: "FS",
    },
  ];
  const body = `
  ${cards
    .map(
      (card) => `
    ${rect(card.x, 166, 282, 256)}
    <rect x="${card.x}" y="166" width="282" height="10" rx="5" fill="${card.color}"/>
    ${text(card.x + 24, 214, card.name, "meta")}
    ${text(card.x + 24, 266, card.source, "label")}
    ${lineText(card.x + 24, 304, [card.detail], "small")}
    ${pill(card.x + 24, 356, card.badge === "API + FS" ? 94 : 62, card.badge, card.color, C.paper)}
  `,
    )
    .join("\n")}
  ${rect(972, 166, 176, 256, { fill: C.bench, stroke: C.bench, radius: 18 })}
  ${text(996, 214, d.bridge, "eyebrow")}
  ${lineText(996, 266, d.bridgeDetail.split(" "), "inverse", 25)}
  ${rect(360, 466, 588, 64, { fill: C.paper, stroke: C.green, radius: 18 })}
  <circle cx="394" cy="498" r="11" fill="${C.green}"/>
  ${text(420, 505, d.rule, "label")}`;
  return base(lang, "runtimeProfiles", body);
}

function routingGuide(lang) {
  const d = copy[lang].routingGuide;
  const body = `
  ${rect(54, 164, 1094, 56, { fill: C.bench, stroke: C.bench, radius: 18 })}
  ${text(601, 199, d.ask, "eyebrow", "middle")}
  ${arrow(420, 220, 290, 266)}
  ${arrow(780, 220, 910, 266)}
  ${rect(54, 266, 470, 94)}
  ${text(78, 302, d.vault, "label")}
  ${pill(78, 316, 150, d.read, C.blue, C.paper)}
  ${text(496, 323, d.any, "small", "end")}
  ${rect(676, 266, 472, 94)}
  ${text(700, 302, d.external, "label")}
  ${pill(700, 316, 130, d.externalRead, C.blue, C.paper)}
  ${arrow(910, 360, 782, 404)}
  ${arrow(910, 360, 1016, 404)}
  ${rect(558, 404, 276, 116)}
  ${text(582, 436, d.handoff, "meta")}
  ${text(582, 474, d.local, "label")}
  ${text(582, 501, d.remote, "small")}
  ${rect(858, 404, 290, 116, { fill: C.surface, stroke: C.copper, radius: 18 })}
  ${text(882, 436, d.move, "meta")}
  ${text(882, 474, d.gated, "label")}
  ${text(882, 501, d.controls, "small")}
  ${text(54, 548, d.boundary, "small")}`;
  return base(lang, "routingGuide", body);
}

const visuals = [
  { slug: "overview", render: overview },
  { slug: "documentation-hub", render: documentationHub },
  { slug: "operations", render: operations },
  { slug: "security", render: security },
  { slug: "runtime-profiles", render: runtimeProfiles },
  { slug: "routing-guide", render: routingGuide },
];

await mkdir(outputDir, { recursive: true });

const files = [];
for (const visual of visuals) {
  for (const lang of ["en", "fr"]) {
    const filename = `${visual.slug}.${lang}.svg`;
    const svg = visual.render(lang).replace(/[ \t]+$/gm, "");
    await writeFile(path.join(outputDir, filename), svg, "utf8");
    files.push({
      filename,
      slug: visual.slug,
      language: lang,
      width: 1200,
      height: 630,
      format: "svg",
    });
  }
}

const manifest = {
  schemaVersion: 1,
  generatedBy: "scripts/generate-readme-visuals.mjs",
  sourceOfTruth: "README visual brief: Optimike editorial system",
  palette: C,
  fonts: {
    display: ["Newsreader", "Georgia", "serif"],
    sans: ["DM Sans", "Inter", "Arial", "sans-serif"],
    mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
  },
  constraints: {
    dimensions: "1200x630",
    editableText: true,
    externalDependencies: false,
    rasterContent: false,
  },
  files,
};

await writeFile(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Generated ${files.length} SVG files in ${outputDir}`);
