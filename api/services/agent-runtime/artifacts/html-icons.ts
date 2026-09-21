import { createRequire } from "node:module";
import { ArtifactError } from "./contracts.js";
/** Read only trusted, packaged Lucide definitions. Generated workspace code is never evaluated. */
export function htmlIconRuntime(entry: string): string {
  const icons = createRequire(
    typeof __filename === "string" ? __filename : import.meta.url,
  )(entry) as Record<
    string,
    {
      render?: (
        props: Record<string, unknown>,
        ref: null,
      ) => { props?: { iconNode?: unknown } };
    }
  >;
  const definitions: Record<string, unknown> = Object.create(null);
  for (const [name, component] of Object.entries(icons)) {
    if (
      !/^[A-Z][A-Za-z0-9]+$/.test(name) ||
      typeof component?.render !== "function" ||
      name.endsWith("Icon") ||
      name.startsWith("Lucide")
    )
      continue;
    const nodes = component.render({}, null)?.props?.iconNode;
    if (
      !Array.isArray(nodes) ||
      !nodes.every(
        (n) =>
          Array.isArray(n) &&
          [
            "path",
            "circle",
            "rect",
            "line",
            "polyline",
            "polygon",
            "ellipse",
          ].includes(n[0]),
      )
    )
      continue;
    definitions[name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()] =
      nodes;
  }
  if (!Object.keys(definitions).length)
    throw new ArtifactError(
      "POLICY_BLOCKED",
      "Packaged Lucide icon definitions are unavailable",
    );
  return `(()=>{const icons=${JSON.stringify(definitions)};window.lucide=Object.freeze({createIcons(options={}){for(const placeholder of document.querySelectorAll('[data-lucide]')){const name=placeholder.getAttribute('data-lucide');const nodes=icons[name];if(!nodes)continue;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value]of Object.entries({width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round',...(options.attrs||{})})){if(!key.startsWith('on')&&!['href','style'].includes(key))svg.setAttribute(key,String(value));}for(const attr of placeholder.attributes){if(['class','aria-label','aria-hidden','role','id'].includes(attr.name))svg.setAttribute(attr.name,attr.value);}svg.dataset.lucideIcon=name;for(const [tag,attributes]of nodes){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes)){if(key!=='key')node.setAttribute(key,String(value));}svg.append(node);}placeholder.replaceWith(svg);}}});document.addEventListener('DOMContentLoaded',()=>window.lucide.createIcons(),{once:true});})();`;
}
