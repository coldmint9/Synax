import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileTypeIcon } from "../FileTypeIcon";

afterEach(cleanup);

describe("FileTypeIcon", () => {
  it.each([
    ["src/App.tsx", "tabler-icon-brand-react"],
    ["src/App.jsx", "tabler-icon-brand-react"],
    ["src/index.ts", "tabler-icon-brand-typescript"],
    ["types/index.d.ts", "tabler-icon-brand-typescript"],
    ["index.mts", "tabler-icon-brand-typescript"],
    ["index.cjs", "tabler-icon-brand-javascript"],
    ["App.vue", "tabler-icon-brand-vue"],
    ["App.svelte", "tabler-icon-brand-svelte"],
    ["index.astro", "tabler-icon-brand-astro"],
    ["app.py", "tabler-icon-brand-python"],
    ["main.go", "tabler-icon-brand-golang"],
    ["lib.rs", "tabler-icon-brand-rust"],
    ["view.swift", "tabler-icon-brand-swift"],
    ["app.kt", "tabler-icon-brand-kotlin"],
    ["main.cpp", "tabler-icon-brand-cpp"],
    ["main.cs", "tabler-icon-brand-c-sharp"],
    ["index.php", "tabler-icon-brand-php"],
    ["index.html", "tabler-icon-brand-html5"],
    ["index.css", "tabler-icon-brand-css3"],
    ["index.scss", "tabler-icon-brand-sass"],
    ["schema.graphql", "tabler-icon-brand-graphql"],
    ["package.json", "tabler-icon-brand-npm"],
    ["package-lock.json", "tabler-icon-brand-npm"],
    ["yarn.lock", "tabler-icon-brand-yarn"],
    ["pnpm-lock.yaml", "tabler-icon-brand-pnpm"],
    ["Cargo.toml", "tabler-icon-brand-rust"],
    ["go.mod", "tabler-icon-brand-golang"],
    ["pyproject.toml", "tabler-icon-brand-python"],
    ["deno.json", "tabler-icon-brand-deno"],
    [".node-version", "tabler-icon-brand-nodejs"],
    [".gitignore", "tabler-icon-brand-git"],
    ["Dockerfile", "tabler-icon-brand-docker"],
    ["Dockerfile.dev", "tabler-icon-brand-docker"],
    ["prod.dockerfile", "tabler-icon-brand-docker"],
    ["docker-compose.prod.yml", "tabler-icon-brand-docker"],
    ["angular.json", "tabler-icon-brand-angular"],
    ["tsconfig.app.json", "tabler-icon-brand-typescript"],
    ["jsconfig.json", "tabler-icon-brand-javascript"],
    ["vite.config.ts", "tabler-icon-brand-vite"],
    ["next.config.mjs", "tabler-icon-brand-nextjs"],
    ["nuxt.config.ts", "tabler-icon-brand-nuxt"],
    ["tailwind.config.cjs", "tabler-icon-brand-tailwind"],
    ["C:\\src\\App.TSX", "tabler-icon-brand-react"],
    ["notes.md", "lucide-file-text"],
    ["image.svg", "lucide-file-image"],
    ["settings.json", "lucide-file-braces"],
    ["config.yaml", "lucide-file-cog"],
    [".env.local", "lucide-file-cog"],
    ["main.java", "lucide-file-code"],
    ["data.csv", "lucide-file-spreadsheet"],
    ["archive.tar.gz", "lucide-file-archive"],
    ["clip.mp4", "lucide-file-play"],
    ["sound.wav", "lucide-file-headphone"],
    ["query.sql", "lucide-database"],
    ["run.sh", "lucide-file-terminal"],
    ["LICENSE", "lucide-file-text"],
    ["unknown.xyz", "lucide-file"],
    ["no-extension", "lucide-file"],
    ["dir.ts/no-extension", "lucide-file"],
    ["", "lucide-file"],
    ["__proto__", "lucide-file"],
    ["constructor", "lucide-file"],
  ])("renders %s as a monochrome %s", (path, expectedClass) => {
    const { container } = render(<FileTypeIcon path={path} />);
    const icon = container.querySelector("svg")!;
    expect(icon).toHaveClass(expectedClass, "file-type-icon");
    expect(icon).toHaveAttribute("fill", "none");
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon).toHaveAttribute("stroke-width", "2");
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("height", "12");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    expect(
      icon.querySelector(
        '[fill]:not([fill="none"]), [stroke]:not([stroke="currentColor"])',
      ),
    ).toBeNull();
  });

  it("preserves custom size, class and original filename", () => {
    const { container } = render(
      <FileTypeIcon
        path="C:\\src\\App.TSX"
        size={16}
        className="custom-icon"
      />,
    );
    const icon = container.querySelector("svg")!;
    expect(icon).toHaveClass("custom-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon).toHaveAttribute("data-file-type-icon", "App.TSX");
  });
});
