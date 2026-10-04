# Adapter le core à WebGPU et TSL

Ce document explique comment faire tourner des scènes Three.js en WebGPU avec TSL, en réutilisant la machinerie décrite dans [`webgl/README.md`](../webgl/README.md).

Lis ce document-là d'abord. Celui-ci ne répète pas comment le core fonctionne, il dit seulement ce qui change.

La référence pour le style d'écriture est l'exemple officiel [`webgpu_animation_retargeting.html`](https://github.com/mrdoob/three.js/blob/master/examples/webgpu_animation_retargeting.html). Les extraits ci-dessous en reprennent les idiomes.

## La bonne nouvelle

Le core ne connaît ni OGL ni WebGL. Il distribue des instances, prête des canvas et appelle `onUpdate` puis `onRender`. Rien là-dedans n'est spécifique à une librairie.

Deux détails montrent qu'il était déjà prêt :

- `RendererPool` accepte un type `'webgpu'` en plus de `'webgl'`.
- La fabrique de renderer peut être asynchrone. C'est indispensable pour WebGPU, dont l'initialisation est une promesse.

## La règle d'import

**Tout vient de `three/webgpu`, jamais de `three`.**

```ts
import * as THREE from 'three/webgpu';
import { Fn, color, screenUV, time, uv, vec3 } from 'three/tsl';
```

`three/webgpu` réexporte tout le coeur de three en plus du renderer et des matériaux à nodes. Mélanger les deux entrées dans un même projet charge deux copies de three, et les `instanceof` cessent de fonctionner. L'exemple officiel est explicite là-dessus : son import map fait pointer `"three"` **et** `"three/webgpu"` vers le même fichier `three.webgpu.js`.

Au passage, beaucoup de tutoriels montrent encore `three/addons/renderers/webgpu/WebGPURenderer.js`. C'est l'ancien chemin.

## Ce qui se copie, ce qui se réécrit, ce qui se jette

| Fichier du dossier `webgl/`         | Quoi en faire                      |
| ----------------------------------- | ---------------------------------- |
| `core/CanvasManager.ts`             | Copier, deux renommages ci-dessous |
| `core/CanvasComponent.ts`           | Copier tel quel                    |
| `core/RendererPool.ts`              | Copier tel quel                    |
| `core/Ticker.ts`                    | Copier tel quel                    |
| `core/PixelManager.ts`              | Copier tel quel                    |
| `utils/hooks.ts`, `utils/logger.ts` | Copier (le core les importe)       |
| `web-component/`                    | Copier, en changeant la balise     |
| `ogl/OglComponent.ts`               | **Réécrire** en `WebgpuComponent`  |
| `core/ShaderMaterial.ts`            | **Supprimer** — importe `ogl`      |
| `utils/fbo/`                        | **Supprimer** — importe `ogl`      |

`ShaderMaterial` et `utils/fbo/` compilent du GLSL et dessinent un triangle plein écran avec OGL. TSL rend les deux inutiles, et ils empêchent le typecheck de passer tant qu'ils sont là.

Deux renommages dans les copies, sinon les deux systèmes se marchent dessus :

- Dans `utils/logger.ts`, l'identifiant `'CanvasManager'` devient `'WebGPUManager'`, pour distinguer les logs en console.
- En bas de `core/CanvasManager.ts`, le global de debug `window.__CANVAS_MANAGER__` devient `window.__WEBGPU_MANAGER__`.

## Les étapes

### 1. Installer

```sh
npm install three
npm install -D @types/three
```

Three 0.186 ne fournit pas ses propres déclarations TypeScript, d'où le second paquet.

WebGPU exige un contexte sécurisé : `https`, ou `http://localhost`.

### 2. Déclarer l'alias

> Non appliqué dans ce dépôt : `#scripts/*` couvrait déjà le besoin. Voir « Écarts » en bas.

Dans [`tsconfig.json`](../../../tsconfig.json), à côté de `#webgl/*` :

```json
"#webgpu/*": ["./src/scripts/webgpu/*"]
```

Puis la même ligne dans la section `imports` de [`package.json`](../../../package.json). Le `tsconfig` est la source de vérité, un plugin Vite en déduit les alias du bundler.

### 3. Aider Vite

> Non appliqué dans ce dépôt. Voir « Écarts » en bas.

Dans `optimizeDeps.include` de [`vite.config.ts`](../../../vite.config.ts), ajouter `'three'`, `'three/webgpu'` et `'three/tsl'`. Sans ça, le serveur de dev se recharge en boucle la première fois.

### 4. Copier le core, puis nettoyer

Reprendre les fichiers du tableau, supprimer les deux entrées marquées, appliquer les renommages, ajuster les chemins relatifs.

### 5. Écrire l'adaptateur

C'est le seul vrai travail. Voir la section suivante.

### 6. Écrire une scène, puis la brancher

Une classe qui hérite de `WebgpuComponent`, un `static id`, et les méthodes décrites dans [`webgl/README.md`](../webgl/README.md). Ensuite `$CanvasManager.register(...)` dans [`main.ts`](../main.ts) avant `init()`, et une balise avec le même identifiant dans le template.

## L'adaptateur

`webgpu/WebgpuComponent.ts` hérite de `CanvasComponent`. Si tu pars d'une copie de `OglComponent`, voici la traduction complète. Chaque ligne de gauche casse en WebGPU : ces propriétés n'existent que sur OGL.

| OGL                        | Three WebGPU                                      |
| -------------------------- | ------------------------------------------------- |
| `new Renderer({ canvas })` | `new WebGPURenderer({ canvas })` + `await init()` |
| `renderer.gl`              | `renderer.getContext()`, ou `null` en WebGPU      |
| `renderer.dpr = x`         | `renderer.setPixelRatio(x)`                       |
| `renderer.setSize(w, h)`   | `renderer.setSize(w, h, false)`                   |
| `{ value: 0, type: '1f' }` | `uniform(0)`                                      |
| `defines`                  | rien, voir la section TSL                         |
| `'webglcontextlost'`       | `renderer.onDeviceLost`                           |

Attention aussi au canvas : `WebGPURenderer` n'en crée pas un tout seul si tu lui en passes un. Celui que tu fabriques dans `buildRenderer` doit lui être transmis dans les options, sinon il en ouvre un autre dans son coin et ton `<canvas>` reste vide.

### `buildRenderer()`

Elle doit être **asynchrone** et attendre `init()` :

```ts
protected override async buildRenderer(): Promise<RendererEntryData> {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGPURenderer({ canvas, ...this._rendererOptions });

    await renderer.init();

    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;

    return {
        canvas,
        renderer,
        ctx: isWebGPU ? null : (renderer.getContext() as WebGL2RenderingContext),
        type: isWebGPU ? 'webgpu' : 'webgl',
        dispose: () => renderer.dispose(),
    };
}
```

### Pourquoi `await init()`, alors que l'exemple officiel ne le fait pas

L'exemple se contente de `renderer.setAnimationLoop(animate)`, sans `await`. L'initialisation y est bien présente, simplement cachée dans la méthode :

```js
async setAnimationLoop( callback ) {
    if ( this._initialized === false ) await this.init();
    this._animation.setAnimationLoop( callback );
}
```

Three attend donc le backend avant d'appeler `animate` la première fois. En déléguant la boucle à three, l'exemple obtient l'attente gratuitement.

Nous n'utilisons pas `setAnimationLoop` : le ticker du manager est déjà la boucle de tout le site, et il appelle `onRender` dès la frame suivant le montage. Personne n'attend pour nous, et sauter l'étape n'est pas un détail cosmétique :

```js
render( scene, camera ) {
    if ( this._initialized === false ) {
        throw new Error( 'THREE.Renderer: .render() called before the backend is initialized.' );
    }
```

Il faut donc faire à la main ce que `setAnimationLoop` fait tout seul. La fabrique du pool est le bon endroit : elle accepte déjà une promesse, et le composant n'est monté qu'une fois l'entrée résolue. Le `await` disparaît ainsi du chemin de rendu, au lieu de devenir un test répété à chaque frame.

Le seul renoncement est la WebXR, qui réclame `setAnimationLoop`. Si un jour tu en as besoin, ce sera sur un composant à part, hors du ticker partagé.

### `getRendererKey()`

Les options qui changent la nature du contexte entrent dans la clé : `alpha`, `antialias`, `depth`, `stencil`, `samples`, et surtout `forceWebGL`.

### `onRendererPooled()`

Récupère `this.renderer` depuis l'entrée du pool. C'est aussi là que la scène se construit, dans la classe fille.

### Perte de contexte

Pas besoin de deux écouteurs. Three expose un hook unique, appelé par les deux backends :

```ts
protected override mountRenderer(): void {
    this._defaultDeviceLost = this.renderer.onDeviceLost;
    this.renderer.onDeviceLost = this._deviceLostHandler;
}
```

En WebGPU il vient de la promesse `device.lost`, en repli WebGL de l'événement `webglcontextlost`.

Le renderer étant partagé par le pool, `unmountRenderer()` remet le hook d'origine : sans ça, un composant démonté continuerait d'être notifié pour un canvas qui ne lui appartient plus.

### `resize()`

```ts
this.renderer.setPixelRatio(dpr);
this.renderer.setSize(width, height, false);
```

Le troisième argument à `false` : `CanvasComponent` a déjà écrit la largeur et la hauteur CSS du canvas, inutile que three les réécrive.

### Rendu des couleurs

Les exemples officiels règlent le ton dès la création du renderer. Sans ça, les couleurs paraissent délavées :

```ts
renderer.toneMapping = THREE.NeutralToneMapping;
```

## Le repli WebGL

`WebGPURenderer` sait basculer tout seul sur WebGL2 quand WebGPU manque. Tu n'as rien à écrire pour ça.

Pour le forcer, l'option `forceWebGL: true`. Pratique pour comparer les deux backends sur la même scène.

Deux choses à savoir :

- **`forceWebGL` doit être dans la clé du pool.** Sinon un composant qui a demandé WebGL peut recevoir un contexte WebGPU déjà ouvert, et inversement.
- **Le backend réel ne se lit qu'après `init()`.** C'est `init()` qui remplace `renderer.backend` par le repli. Avant, tu lis le backend demandé, pas celui obtenu. Après, `renderer.backend.isWebGPUBackend` dit la vérité. Passe le bon `type` au pool, sinon `getStats()` ment.

## Écrire en TSL

Tu ne manipules plus de chaînes GLSL, mais un graphe construit en JavaScript. Trois choses à comprendre.

**Tout se chaîne.** Il n'y a pas d'opérateurs, on appelle des méthodes :

```ts
// GLSL : sin(uv.y * 10.0 - time * 0.6)
sin(uv().y.mul(10).sub(time.mul(0.6)));
```

**Les valeurs utiles existent déjà.** `time`, `deltaTime`, `uv()`, `screenUV`, `normalWorldGeometry`, `color()` sont fournis par `three/tsl` et se mettent à jour seuls. Pas besoin d'un uniform maison pour le temps :

```ts
const vignette = screenUV.distance(0.5).mix(color(0x0175ad), color(0x02274f));
```

Deux pièges sur `time` : il est en **secondes**, alors que le `clock` du manager est en millisecondes. Et il est global au site, donc il ne se remet pas à zéro quand un composant est recyclé par le pool. Pour un temps propre à une instance, garde un `uniform(0)` alimenté par `scopedElapsedTime`.

**Une fonction réutilisable passe par `Fn`.** C'est l'équivalent d'un `#include` de chunk GLSL. Le `setLayout` est optionnel mais permet à three de générer une vraie fonction au lieu d'inliner le graphe :

```ts
const wave = Fn(([suv]) => {
    return sin(suv.y.mul(10).sub(time.mul(0.6)));
}).setLayout({
    name: 'wave',
    type: 'float',
    inputs: [{ name: 'suv', type: 'vec2' }]
});
```

Le résultat se branche sur un matériau à nodes, ou directement sur la scène :

```ts
const material = new THREE.MeshBasicNodeMaterial();
material.colorNode = vec3(uv(), 0.5);

scene.backgroundNode = vignette;
```

Conséquence pour l'adaptateur : l'objet `uniforms` contient des nodes TSL, et il n'y a plus d'objet `defines`. Une branche conditionnelle se décide en JavaScript au moment de construire le graphe.

## Le nom de la balise

`c-loco-canvas` est déjà enregistré par le dossier `webgl/`. Un second `customElements.define` sur ce nom lève une erreur et casse la page. Choisis un autre nom, par exemple `c-webgpu-canvas`, et pense au fichier CSS qui va avec : ses sélecteurs portent l'ancien nom.

## Checklist

- [x] `npm install three` et `npm install -D @types/three`
- [ ] ~~Alias `#webgpu/*` dans `tsconfig.json` et `package.json`~~ — pas fait, voir « Écarts »
- [ ] ~~`three`, `three/webgpu`, `three/tsl` dans `optimizeDeps.include`~~ — pas fait, voir « Écarts »
- [x] Copier le core, `utils/hooks.ts` et `utils/logger.ts`
- [x] Supprimer `core/ShaderMaterial.ts` et `utils/fbo/`
- [x] Renommer le logger (`WebGPUManager`) et le global de debug (`window.__WEBGPU_MANAGER__`)
- [x] Renommer la balise (`c-webgpu-canvas`) et ses sélecteurs CSS (`web-component/webgpu-canvas.css`)
- [x] Écrire [`webgpu/WebgpuComponent.ts`](webgpu/WebgpuComponent.ts), sans plus aucun import `ogl`
- [x] Écrire une première scène : [`components/TslCube/TslCube.ts`](components/TslCube/TslCube.ts)
- [x] L'enregistrer dans [`main.ts`](../main.ts), poser la balise dans `templates/design-system.twig`
- [x] `npm run typecheck`
- [x] Vérifier en console que le backend actif est bien celui attendu

## La scène d'exemple

[`components/TslCube/TslCube.ts`](components/TslCube/TslCube.ts) : un cube, une caméra, `OrbitControls`, et le minimum de TSL pour montrer les trois idiomes.

| Méthode              | Ce qu'elle fait                                                             |
| -------------------- | --------------------------------------------------------------------------- |
| `onRendererPooled`   | Construit la scène. Le contexte n'existait pas avant.                       |
| `onMounted`          | Crée `OrbitControls` : il écoute le canvas, qui vient d'entrer dans la page |
| `onResize`           | `camera.aspect` puis `updateProjectionMatrix()`                             |
| `onUpdate`           | Fait tourner le cube, puis `controls.update()` pour l'amortissement         |
| `onRender`           | `renderer.render(scene, camera)`                                            |
| `onRendererReleased` | Le pool a prêté notre renderer à un autre composant : on libère le GPU      |

Deux choses à retenir de ce fichier.

**`time` suffit pour animer un shader.** Il est fourni par `three/tsl`, il est en secondes, et il se met à jour seul. Aucun uniform à alimenter depuis le JavaScript. En revanche le `deltaTime` du ticker, lui, est en **millisecondes** — d'où le `* 0.001` avant de faire tourner le mesh.

**Une fonction TSL se déclare au niveau du module, pas dans la classe.** `stripes` est un graphe, pas une valeur : il est construit une fois et réutilisé par toutes les instances.

## Écarts par rapport au plan de ce document

Trois points où le code livré diffère de ce qui est décrit plus haut.

**Pas d'alias `#webgpu/*`.** L'alias `#scripts/*` existait déjà et couvre le besoin : `main.ts` importe `#scripts/webgpu/core/CanvasManager.ts`, et la scène utilise des chemins relatifs vers le core. Rien à déclarer dans `tsconfig.json` ni dans `package.json`.

**Pas de `uniforms` ni de `defines` dans l'adaptateur.** `OglComponent` expose `uScopedTime`, `uTime`, `uResolution` et `uViewportResolution`. L'adaptateur WebGPU n'expose rien de tout ça : `time` est fourni par TSL, et `screenUV` remplace `uResolution` dans la plupart des cas. Une scène qui a vraiment besoin d'un temps propre à son instance déclare son propre `uniform(0)` et l'alimente depuis `scopedElapsedTime`.

**`optimizeDeps.include` n'a pas été touché.** Au premier `npm run dev` suivant, Vite peut recharger en boucle le temps de pré-bundler `three`. `npm run dev -- --force` débloque.

## Le repli WebGL, vérifié

`forceWebGL: true` a été testé dans le navigateur. Le comportement correspond à ce qui est décrit plus haut :

- `renderer.backend.isWebGPUBackend` vaut `false`, l'adaptateur passe donc `type: 'webgl'` au pool ;
- `renderer.getContext()` renvoie un vrai `WebGL2RenderingContext` ;
- `renderer.domElement` est bien le canvas qu'on a fabriqué, confirmant qu'il faut le passer dans les options.

## Deux managers, deux tickers

Le dossier `webgl/` et le dossier `webgpu/` ont chacun leur `$CanvasManager`. Ce sont deux modules distincts, donc deux registres, deux pools de contextes et **deux `requestAnimationFrame`**. `main.ts` appelle `register()`, `init()` et `start()` sur les deux.

C'est acceptable pour une démo, mais si les deux systèmes doivent coexister durablement, mieux vaut faire tourner les deux managers sur le même ticker via `setTicker()`.

## Le poids du bundle

Importer `TslCube` depuis `main.ts` tire `three/webgpu` dans l'entrée principale, qui passe d'environ 400 ko à environ 1 Mo. `OrbitControls` importe depuis `three` et non `three/webgpu`, ce qui ajoute aussi `three.module.js`.

Bonne nouvelle au passage : en 0.186 les deux builds partagent le même `three.core.js`, donc `Controls`, `Vector3` et consorts sont les **mêmes** classes. Le double chargement que craint la section « La règle d'import » ne casse pas les `instanceof` ici ; il ne coûte que des octets. Un alias Vite `three` → `three/webgpu` supprimerait ce surcoût.

Pour un usage en production, charger la scène en `import()` dynamique depuis la page qui en a besoin, plutôt que depuis `main.ts`.

## Si tu veux emporter ce dossier ailleurs

Le core importe des utilitaires partagés du projet : `#utils/async/wait.ts`, `#utils/log/logger.ts`, `#utils/screen/useDPR.ts`, `#utils/screen/useResize.ts`, `#utils/screen/useScreen.ts`, `#utils/string.ts`, `#utils/maths.ts`. Le web component dépend aussi de `@locomotivemtl/component-manager`.

Pour un copier-coller dans un projet vierge, il faut soit emporter ces fichiers, soit les réécrire en versions minimales dans le dossier.
