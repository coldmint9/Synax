/** Generate the small offline Lucide set at build time; never compile user code. */
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  Sparkles,
  Ellipsis,
  WandSparkles,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Check,
  Layers2,
  MessageCirclePlus,
  Search,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Menu,
  Settings,
  Sun,
  Moon,
  GitBranch,
  Code2,
  Folder,
  FileText,
  Copy,
  Play,
  Pause,
  RefreshCw,
  Circle,
  CheckCircle2,
  Clock,
  SlidersHorizontal,
  ArrowDown,
  ArrowUp,
  Info,
} = require("lucide-react");

// Only trusted bundled components are serialized, never generated HTML or JS.
const icons = {
  sparkles: Sparkles,
  ellipsis: Ellipsis,
  "more-horizontal": Ellipsis,
  "wand-sparkles": WandSparkles,
  "arrow-up-right": ArrowUpRight,
  "arrow-right": ArrowRight,
  "arrow-left": ArrowLeft,
  check: Check,
  "layers-2": Layers2,
  "message-circle-plus": MessageCirclePlus,
  search: Search,
  plus: Plus,
  x: X,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  menu: Menu,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  "git-branch": GitBranch,
  "code-2": Code2,
  folder: Folder,
  "file-text": FileText,
  copy: Copy,
  play: Play,
  pause: Pause,
  "refresh-cw": RefreshCw,
  circle: Circle,
  "circle-check": CheckCircle2,
  clock: Clock,
  "sliders-horizontal": SlidersHorizontal,
  "arrow-down": ArrowDown,
  "arrow-up": ArrowUp,
  info: Info,
};
const visualizationIcons = Object.fromEntries(
  Object.entries(icons).map(([name, icon]) => [
    name,
    renderToStaticMarkup(
      createElement(icon, { width: 16, height: 16, "aria-hidden": true }),
    ),
  ]),
);

writeFileSync(
  fileURLToPath(
    new URL(
      "../web/src/react/features/visualizations/icons.json",
      import.meta.url,
    ),
  ),
  JSON.stringify(visualizationIcons, null, 2) + "\n",
);

writeFileSync(
  new URL(
    "../web/src/react/features/visualizations/icons.LICENSE",
    import.meta.url,
  ),
  readFileSync(
    join(dirname(require.resolve("lucide-react/package.json")), "LICENSE"),
  ),
);
