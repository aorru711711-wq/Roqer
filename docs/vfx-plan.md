# VFX study

Status as of 2026-10-02: steps 1 and 2 are implemented, unit tested and
checked live in Studio and Blender; open questions 1 and 2 are answered. A
study of experienced artists' published effects ("Reference study" below)
reshaped the guidance and added texture drawing. The document also records
how strong Roblox VFX are built today, what the agent can and cannot do toward
that, and a proposed order of work. Web facts were gathered on that date and
carry their sources. Items tagged **[unverified]** are common
practice or inference with no primary source found; do not turn them into
defaults without testing them.

## Where VFX stands today

- **Blender can make the parts, by hand.** The `blender` tool runs any bpy
  script headless (`apps/desktop/runtime/blender-worker.ts`). It exports
  `.glb/.gltf/.fbx/.obj` models, which Roqer re-imports and inspects, and PNG
  renders. Today the user gets flipbooks and slash meshes by telling the agent
  to write the whole bpy pipeline itself: rendering the frames, packing the
  grid, writing the UVs.
- **The worker does not know what a flipbook is.** A PNG is just a PNG. At most
  4 are read per job (`MAX_RENDERED_IMAGES`), a side over 1024 is flagged
  (`MAX_UPLOAD_IMAGE_SIDE`), and a file over 2 MB is not attached
  (`MAX_PREVIEW_BYTES`, `blender-worker.ts:38-44`). Nothing checks that a sheet
  divides evenly into its grid, that no frame bleeds into its neighbour, that no
  cell is empty, or which blending mode the sheet was made for.
  `grep -ri flipbook` over the repo finds nothing.
- **No mesh-VFX helpers.** `roqer.*` helpers cover kit building and rigs (`box`,
  `cylinder_between`, `join`, `paint`, `bind`, `skin`, `export_animation`;
  `roblox-building/references/blender.md`). There are no crescents, rings,
  spirals or swirls, and no rule for laying out UVs on them.
- **Studio-side creation works.** `build_instances` creates `ParticleEmitter`,
  `Beam`, `Trail` and `Attachment` with sequences and ranges converted by the
  plugin (`studio-plugin/src/modules/Utils.ts`). `upload_asset` with `Decal`
  returns the `imageId` a `ParticleEmitter.Texture` or `Beam.Texture` needs
  (`packages/core/src/tools/index.ts:5396`). `search_assets` takes
  `assetType: "VFX"`, and `preview_asset` reports `hasVfx`.
- **Guidance is thin.** The `roblox-animation-vfx` skill
  (`references/full.md` §4-8) covers `Rate = 0` with `:Emit(n)`, attachments
  for beams and trails, tweening, `Debris` and pooling. It says nothing about
  textures, flipbooks, mesh VFX, layering, timing, impact frames or
  performance budgets.
- **The agent cannot see motion.** `capture_screenshot` takes a still. Each
  capture goes through `capture-begin`/`capture-read` round trips
  (`index.ts:5903-5910`), far slower than a 0.3 s burst. The only multi-frame
  check in the product is the animation contact sheet
  (`packages/core/src/animation/contact-sheet.ts`), and it draws rigs only.
  **This is the largest gap.** An effect is mostly timing, and the agent cannot
  check timing.

## How strong Roblox VFX are built

### Mesh VFX

Since about 2018, battlegrounds-style games have built VFX from tweened meshes
that grow, spin and fade, layered with particles
([DevForum, 2026](https://devforum.roblox.com/t/roblox-3d-vfx-for-meshvfx/4585601)).
The meshes are crescent slashes, shockwave rings, twisted cylinders (swirls,
tornadoes), cones and sphere shells, made in Blender. One published recipe:
start from a cylinder subdivided three times; apply Vertex Weight Edit, Mask,
Smooth and a 360° Simple Deform twist; export; give it Neon in Studio
([tutorial](https://devforum.roblox.com/t/vfx-tutorial-roblox/872437)).

What the engine offers a mesh effect:

| Technique | How it works | Limit |
| --- | --- | --- |
| `MeshPart.TextureID` + `Transparency`/`Color`/`Size` tweens | The base of most mesh VFX | `TextureID` has **no UV offset**, so it cannot scroll ([MeshPart](https://create.roblox.com/docs/reference/engine/classes/MeshPart)) |
| `DoubleSided` | Lets a one-sided card (a slash) show from behind | — |
| Vertex colours | Imported from FBX and multiplied by `Color`, so set the part white | MeshPart only ([staff post](https://devforum.roblox.com/t/vertex-colored-meshes-using-blender-and-studio/3050119)) |
| `ForceField` material with a texture | The red channel picks which pixels show as an internal window sweeps; alpha sets strength; fresnel at the edges | Speed cannot be controlled, so it suits a shimmer or dissolve, not a timed wipe ([announcement](https://devforum.roblox.com/t/new-material-forcefield-v20/297785), [analysis](https://devforum.roblox.com/t/how-forcefield-texture-animation-works/3041374)) |
| `Texture` instance with `OffsetStudsU/V` | Scrolls, but projects along face normals rather than using the mesh's UVs | Wrong for curved cards ([thread](https://devforum.roblox.com/t/scrollable-textures-for-meshparts/2820890)) |
| Swapping `TextureID` per frame | A flipbook on a mesh | One asset per frame ([mesh flipbook pack](https://devforum.roblox.com/t/open-source-mesh-flipbook-pack/3635032)) |
| `Bone.Transform` on a skinned mesh | Bends a ribbon or tendril from script | ([Bone](https://create.roblox.com/docs/reference/engine/classes/Bone)) |
| `EditableMesh` / `EditableImage` | Rewrite UVs (`SetUV`) or pixels at runtime | Gated by the player's ID verification (below) |

`SurfaceAppearance` has emissive maps, but "most SurfaceAppearance properties
cannot be modified by scripts"
([reference](https://create.roblox.com/docs/reference/engine/classes/SurfaceAppearance)),
so scripted mesh VFX use `TextureID`.

**[unverified]** Lay out a slash or ring so the sweep runs along U and fade
the tail with an alpha gradient in the texture. Ease `Size` out to 2-4× with
Quad or Expo over 0.2-0.5 s while `Transparency` goes from 0 to 1.

### Particles

All from the [ParticleEmitter reference](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter)
unless marked:

- **Flipbooks:**
  - `FlipbookLayout` (None, Grid2x2, Grid4x4, Grid8x8, Custom);
    `FlipbookSizeX/Y` apply to Custom.
  - `FlipbookMode` (Loop, OneShot, PingPong, Random). In OneShot the rate is
    lifetime divided by the frame count.
  - `FlipbookFramerate` goes up to 30 fps. Also `FlipbookStartRandom` and
    `FlipbookBlendFrames`.
  - `FlipbookIncompatible` holds the error text, for example "flipbook texture
    size must be an exact multiple of the flipbook layout size".
  - The particle guide gives an 8×8 layout on a 1024² image (64 frames) and
    says to leave spacing between frames. Flipbooks can be disabled on
    low-memory devices
    ([guide](https://create.roblox.com/docs/effects/particle-emitters)).
  - Custom layouts of 1-64 cells per side, with non-square sheets, entered
    Client Beta on 2025-10-13
    ([announcement](https://devforum.roblox.com/t/client-beta-optimize-your-particle-animations-with-custom-flipbook-layouts/4005128)).
    Whether they have left beta is unverified.
- **Blending:**
  - `LightEmission` 1 is additive; use it with black-background RGB textures
    for fire and energy. `LightEmission` 0 is normal alpha blending; use it
    for smoke.
  - There is no multiply or premultiplied mode
    ([request](https://devforum.roblox.com/t/proper-alpha-blend-multiply-for-particles/216474)).
  - Also `LightInfluence`, `Brightness` and `ZOffset`, which layers without
    changing on-screen size.
- **Shape:**
  - `Squash` with `Orientation = VelocityParallel` makes streaked sparks.
  - `Shape`: Box, Sphere, Cylinder or Disc. Also `ShapeStyle` and
    `ShapeInOut`, where Inward suits anticipation.
  - `ShapePartial` on a Disc makes a ring
    ([shapes](https://devforum.roblox.com/t/new-procedural-particle-emitter-shapes/1517642)).
- **Motion:**
  - `Drag` is the half-life of speed. Also `Acceleration` and
    `LockedToPart`.
  - `TimeScale` 0 freezes particles. It is the engine's hitstop hook, and it
    matters for verification (below).
- **Missing from the engine:** mesh particles, collisions, sub-emitters and
  turbulence ([overhaul request](https://devforum.roblox.com/t/particle-system-revampoverhaul/4005723)).
  Studios work around them with mesh VFX and scripted layers.

### Beams, trails, lightning

- **Beams:**
  - A Beam is a cubic Bezier: `CurveSize0/1` bend it into arcs.
  - `Segments` must be at least the keypoint count minus one.
  - `TextureSpeed` scrolls the texture (negative reverses). `SetTextureOffset`
    scrubs it by hand
    ([Beam](https://create.roblox.com/docs/reference/engine/classes/Beam)).
  - Beams are the one built-in way to scroll a texture along a curve.
- **Trails:** width comes from the two attachments times `WidthScale`, and
  `Lifetime` runs from 0.01 to 20 s
  ([Trail](https://create.roblox.com/docs/reference/engine/classes/Trail)).
  - **[unverified]** For a weapon slash, enable the trail only during the
    swing, with a lifetime of about 0.1-0.3 s and `LightEmission` 1.
- **Lightning:** the Lightning Beams module (used in Elemental Battlegrounds)
  moves layered noise along a Bezier
  ([repo](https://github.com/SamyBlue/Lightning-Beams)).

### Composition, timing and feel

- **One container, driven by keyframe events.** Artists weld the effect parts
  to the character, animate them with the attack, and let keyframe events
  drive emission
  ([workflow breakdown, 2025](https://devforum.roblox.com/t/stoic-bomb-vfx-recreation-and-personal-workflow-overview/3608056)).
  The engine hooks are `GetMarkerReachedSignal` and `KeyframeReached`
  ([AnimationTrack](https://create.roblox.com/docs/reference/engine/classes/AnimationTrack)).
  Roqer's `animation` tool already writes markers.
- **An attribute convention the tools share.** VFX Editor, Advanced VFX Plugin
  and VFX Forge all read `EmitCount`, `EmitDelay` and `EmitDuration` from
  emitter attributes, and a module walks a model's descendants to emit them
  ([VFX Editor](https://devforum.roblox.com/t/vfx-editor-all-your-vfx-needs-in-one/3103467),
  [VFX Forge docs](https://docs.zilibobi.dev/vfx-forge/effects/particle/),
  [forge-vfx](https://github.com/zilibobi/forge-vfx)).
  - VFX Forge animates a mesh effect from `Start` and `End` parts whose
    position, size and scale act as keyframes, with tween curves for each
    property ([mesh effects](https://docs.zilibobi.dev/vfx-forge/effects/mesh/)).
  - An agent that writes effects in this shape produces something a VFX
    artist can open and tune.
- **Screen feedback:**
  - `ColorCorrectionEffect` and `BloomEffect` under `CurrentCamera` affect
    only the local player
    ([ColorCorrection](https://create.roblox.com/docs/reference/engine/classes/ColorCorrectionEffect)).
  - Impact frames use black colour correction, a white `Highlight` and speed
    lines. Some colour-correction settings hide particles
    ([impact frames](https://devforum.roblox.com/t/advanced-impact-frames/2468478)).
  - The `Highlight` limit rose to 255 on 2025-11-10
    ([announcement](https://devforum.roblox.com/t/lights-camera-more-highlights/4061534)).
  - Camera shake: RbxCameraShaker presets
    ([repo](https://github.com/Sleitnick/RbxCameraShaker)).
- **[unverified] Layering and timing:**
  - Layers: an additive core, a faint large glow, streaked sparks, alpha
    smoke, a shockwave ring, ground cracks or a decal, and a `PointLight`
    flash.
  - Timing: anticipation 0.1-0.3 s, impact 1-3 frames, dissipation 0.5-1.5 s.
  - No primary source gives numbers. Treat them as starting points the
    verification has to judge, not rules.

### Runtime and performance

- **Replication:** the server decides and fires an id plus parameters, and
  each client renders. `UnreliableRemoteEvent` is meant for effects and drops
  payloads over 1000 bytes
  ([reference](https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent)).
  The networking skill already says this.
- **Draw calls:** particles, decals and textures do not batch. Overlapping
  transparency causes overdraw, and changing emitter properties can be costly.
  Most textures should be 512² or smaller
  ([performance guide](https://create.roblox.com/docs/performance-optimization/improve)).
  The particle guide caps emission at 400/s (100 on mobile).
- **Quality scaling:** `UserGameSettings.SavedQualityLevel` is readable from a
  LocalScript; the automatic level is not exposed
  ([UserGameSettings](https://create.roblox.com/docs/reference/engine/classes/UserGameSettings)).
- **Physics debris:** in one heavy fighting game, the lag came from physics
  debris rocks, not particles. Pooling and building the effects on the client
  fixed it
  ([thread](https://devforum.roblox.com/t/optimization-for-heavy-vfxparts-fighting-games/3824000)).

### Texture sources

- **Flipbooks from Blender:** render with a transparent film (Cycles or
  Eevee), then pack the frames into a grid
  ([example, 2024](https://devforum.roblox.com/t/2-free-realistic-flipbook-particle-explosions/3035597)).
  The author of that example had trouble with transparency when packing, the
  same step Roqer could do in trusted code.
- **Slashes and dissolves from After Effects**
  ([slash](https://devforum.roblox.com/t/after-effects-slash-vfx-tutorial/3894233),
  [shockwave](https://devforum.roblox.com/t/after-effects-dissolve-shockwave-tutorial/3894243)).
- **Fluid simulations from EmberGen**, exported as flipbooks with configurable
  grids. EmberGen is commercial, closed and GUI-driven, so an agent cannot
  drive it.
- **Blender** remains the one scriptable, free source in this set.

### Engine features worth watching

- **EditableMesh and EditableImage:**
  - Limits: 1024² images and 60k vertices / 20k triangles per mesh.
  - EditableMesh batching APIs reached full release in September 2026
    ([announcement](https://devforum.roblox.com/t/full-release-editablemesh-batching-apis-parallel-queries/4779401)).
  - In published games they still require the player to be 13+ and
    ID-verified, and the creator must enable the APIs
    ([EditableImage](https://create.roblox.com/docs/reference/engine/classes/EditableImage)).
  - So any runtime effect built on them needs a fallback for most players.
- **No official VFX template or pack exists.** The Creator Store's Visual
  Effects category is community content.

## What decides the design

1. **A slice is worth building only if Roqer can check its output itself.**
   This is the same rule as the Blender worker and the audio study.
   - Sheet geometry, alpha and mesh UV facts can be checked locally from
     files.
   - Motion in Studio cannot be checked yet, and it is what makes an effect
     good or bad.
2. **Each part goes in the layer that owns it** (AGENTS.md):
   - Baking flipbooks and making VFX meshes is local orchestration, so it
     belongs in the Blender worker, beside `roqer.export_animation`.
   - Capturing frames of a running effect needs the viewport, so it belongs in
     the plugin and MCP.
   - Composition, timing and property recipes are guidance for the
     `roblox-animation-vfx` skill.
   - Nothing should simulate Roblox rendering outside Studio. Showing a baked
     sheet as an animated strip in a result card is image data, like the 3D
     viewer, and is fine.
3. **Uploads are irreversible and moderated.** VFX need many small textures
   and meshes.
   - Pack textures into shared sheets, and reuse one texture across emitters
     with different `Color`, `Size` and `Squash`.
   - Tell the user the upload count before uploading.
   - The image and mesh upload quota for an unverified account is not known
     (open question 3), so no figure is assumed here.
4. **Write effects in the shape artists already use.** Use one Model per
   effect, emitters with `EmitCount`/`EmitDelay`/`EmitDuration` attributes,
   and `Start`/`End` parts for meshes. The result is then legible to the user
   and to VFX tooling, and does not invent a format. Step 3 below is in
   tension with this rule; see the choice it names.

## Proposed order of work

### 1. Guidance first (no product code)

Add `roblox-animation-vfx/references/vfx-craft.md`, loaded for any effect
request. The emit module below is Luau carried in that reference, which the
agent inserts into the game, not a desktop or core component. It should cover:

- the layer list and the anticipation, impact and dissipation structure
  (tagged as starting points);
- flipbook properties and the sheet rules: exact multiple, spacing, square
  1024² with 8×8, and when to use `LightEmission` 1 or 0;
- spark, smoke, ring and glow recipes as property sets that `build_instances`
  accepts;
- Beam arcs (`CurveSize`, `Segments`, `TextureSpeed`) and trail slashes;
- mesh VFX: card meshes with `DoubleSided`, white `Color` under vertex
  colours, `ForceField` for shimmer only, and why `TextureID` cannot scroll;
- impact frames and hitstop through `TimeScale`;
- a reference emit module written in this repo. It reads the shared
  attributes, plays `Start`→`End` mesh tweens, and is driven by animation
  markers;
- the performance rules above;
- how to search the Creator Store for an existing texture before uploading a
  new one.

Acceptance:

- every property name in the reference exists in the creator-docs API dump;
- the emit module runs in a playtest (`solo_playtest`);
- a test, like `animation-recipes.test.ts`, extracts its recipes and checks
  them against the plugin's value conversions.

Drafted 2026-10-02:

- **What was added:** `references/vfx-craft.md`, the emit module
  `templates/vfx/emit.lua`, and `apps/desktop/runtime/vfx-craft.test.ts`.
- **What the test checks:**
  - recipe properties against the `@rbxts/types` 1.0.906 typings;
  - value shapes against the plugin's conversions;
  - textures against the built-in particle textures, which were read from a
    Studio install;
  - recipe attributes against what the module reads.
- **The module's clock:** it drives particles, mesh motion and light fades
  itself, so `setTimeScale` and `freeze` cover all three without banning
  `TweenService` elsewhere. That answers step 3's choice for effects played
  through the module.
- **Checked outside Studio:** `luau-compile` 0.740 compiles the module, and a
  one-off run under plain Luau with stand-in Roblox objects showed bursts,
  delays, hitstop, slow motion, in-place restore and warnings behaving as
  intended.
- **Live in Studio, 2026-10-02** (a scratch place, through the built bridge,
  addressed by instance id):
  - every recipe was built verbatim from the reference in one atomic
    `build_instances` batch and read back as written;
  - the module was installed with `set_script_source` and loads with
    `require`;
  - the effect played in the edit viewport and in a solo playtest client;
  - `freeze(1)` held the clock (0.318 before and during, 0.617 after);
  - no `VFXEmit` warnings were logged.
- **The first contact sheet showed the recipes too faint.** The gather and
  sparks were hairlines, the smoke barely visible, and the neon ground disc
  buried the shockwave ring. They were retuned (larger, `Brightness`, darker
  smoke, a more transparent disc) until every layer read in a second sheet.
- **Fixed by the live run:** `build_instances` cannot use a service as its
  root and creates a missing root as a Model. The module therefore lives at
  `ReplicatedStorage.VFX.Emit`, not `ReplicatedStorage.VFXEmit`.
- **Three briefed effects** (fire punch, teleport, sword slash) were built
  and tuned by contact sheet in the scratch place. They taught five things,
  now in the reference:
  - `build_instances` cannot set Beam or Trail `Attachment0`/`1`, so links
    need one `execute_luau`. That is a candidate for a `build_instances`
    reference-property extension.
  - Edit-mode `require` caches a ModuleScript for the whole session.
  - Trails age in real time, so frozen frames lose them. The module now
    stretches trail lifetimes by the time scale, and trail effects are
    captured back to back at `timeScale = 0.04`.
  - A flat slash is edge-on from a low camera.
  - A Neon column below about 0.8 transparency reads as plastic.
- **A mesh-free crescent** comes from a trail swept by the module's `Spin`.

### 2. Blender: flipbooks and VFX meshes with checks Roqer computes

Add worker helpers, on the same pattern as `export_animation`:

- **`roqer.flipbook(frames | frame_range, layout, mode, cell_padding)`**
  renders frames with a transparent film and packs them in trusted code into
  one sheet.
  - Sheets are at most 1024² by default, with a Custom layout as an explicit
    option.
  - `mode` is `"alpha"` (straight alpha) or `"additive"` (black background,
    no alpha).
  - Roqer reports:
    - whether the sheet divides exactly into its grid;
    - any frame whose alpha or brightness touches its cell edge (bleed);
    - any empty or duplicate cell;
    - coverage per frame, so the user can see that a burst grows and fades;
    - the matching `FlipbookLayout`, `FlipbookMode` and `LightEmission`
      settings.
  - The sheet comes back as a single image, so the 4-image cap holds, and the
    result card can play it as an animated strip.
  - Render time is a budget. A job is capped at 200 s, and 64 Cycles frames
    may not fit. Default to Eevee (or Workbench for flat shapes), use Cycles
    only on request, and split a long sheet across jobs with `continue_from`,
    packing at the end. Roqer reports render time per frame so the agent can
    plan the split.
- **Mesh primitives:**
  - The helpers are `roqer.vfx_slash`, `vfx_ring`, `vfx_swirl`, `vfx_cone`
    and `vfx_shell`, each with sweep angle, thickness, twist and segment
    count.
  - Each one lays out UVs with the sweep along U, and can bake an alpha
    gradient texture.
  - The existing re-import inspection adds a UV-range check and a triangle
    count against the 20k limit.
- **Texture helpers:** gradient, ring, noise and streak textures (glows,
  sparks, smoke puffs), rendered or composited in Blender.
  - They give the agent a starter set without a generative image model.
  - Every texture is original by construction, which lowers moderation risk.

Acceptance:

- the same script renders the same sheet: same frame numbers, same layout,
  and coverage within tolerance. Eevee is not bit-stable across GPUs, so not
  byte for byte;
- a malformed layout is refused, naming the valid range;
- the checks come from Roqer's own read of the PNG, never from the agent;
- a live check: one uploaded sheet plays in a `ParticleEmitter` with no
  `FlipbookIncompatible` message and no visible bleed.

**Flipbooks done 2026-10-02; mesh primitives and texture helpers not
started.** The flipbook slice as built:

- **`roqer.flipbook(name, grid, mode, start, end, loop, padding)`**
  - Grids are 2, 4 or 8 only, and the sheet is always 1024² (Custom layouts
    were left out).
  - Frames are sampled evenly to fill every cell, and the animation must have
    at least as many frames as cells.
  - Frames render into the job folder, `padding` pixels inside their cells.
  - The view transform is set to Standard while rendering, and the scene's
    settings are restored afterwards.
  - The sheet is packed with numpy and written by a small PNG writer, not
    Blender's image saver.
  - A note beside the sheet records the grid, mode, loop flag, frames and
    per-frame render time.
- **`runtime/flipbook-sheet.ts`** decodes the sheet itself, treats the note
  as a claim, and reports:
  - the grid its gutters agree with;
  - coverage per cell;
  - empty cells (a faded tail is fine for a one-shot sheet);
  - cells the subject runs off the edge of;
  - frozen frames;
  - the settings to use.

  It refuses any size but 1024², and a palette or interlaced PNG.
- **The result:** sheets get their own section in the Blender result, apart
  from renders. A sheet too large to attach is replaced by a half-size copy
  the helper writes.
- **Live, Blender 5.2:**
  - Eevee rendered 64 frames in 4.1 s; Cycles took 0.28 s a frame for a
    simple 4x4 sheet.
  - Packing order, padding and alpha were checked by eye.
  - An oversized subject was caught as cut off in 7 cells.
  - The reference's example runs as written.
- **In Studio, 2026-10-02:** one sheet was uploaded with the user's approval:
  the GlowBurst 8x8 additive sheet, decal 106191190033458, image
  131517682949853, approved by moderation at once.
  - On a `ParticleEmitter` with Roqer's reported settings, one particle held
    at six ages showed one frame each, growing then fading. It played as a
    flipbook, not the whole grid.
  - `FlipbookIncompatible` read "Particle texture must be 1024 by 1024 to use
    flipbooks." throughout. It did so for that working sheet, for a 128 px
    built-in and with no layout set, and it never cleared over 6 s. The
    guidance now says not to go by it and to screenshot held particles
    instead.
- **Not done:** an animated strip in the result card.

**Mesh primitives done 2026-10-02; texture helpers not started.**

- **The helpers:** `roqer.vfx_arc` (crescent), `vfx_ring` (flat band, or a
  wall with a flared top), `vfx_cone`, `vfx_swirl` (helical ribbon) and
  `vfx_shell` (sphere or dome).
  - Each is one open sheet built by a shared strip builder, with UV U along
    the sweep and V across it, facing Blender -Y (Roblox forward).
  - Arguments are checked and refused with their valid ranges.
- **Inspection:** the re-import inspection now reports UVs: meshes with and
  without them, and the range they span, noting when it falls outside 0 to 1.
- **Live, Blender 5.2:** all five shapes built in one job.
  - The preview showed each as intended.
  - UVs spanned 0 to 1 on every mesh, and the six shapes came to 1,760
    triangles.
  - The reference's example ran as written.
- **In Studio, 2026-10-02**, with the user's approval for two uploads: a
  `vfx_arc` crescent (model 93242260704793) and a fade texture (decal
  84595241411908, image 86775129723972). Both were approved at once.
  - The crescent arrived as a MeshPart, 0.001 studs thick, in a Model under
    `Crescent_Node`.
  - The texture was tried on crescents in front of a green wall:
    - `TextureID` on red SmoothPlastic, also at `Transparency` 0.01, and on
      white Neon: white everywhere, so alpha is ignored. Nothing showed
      through and no red appeared.
    - `SurfaceAppearance`, `AlphaMode = Transparency`: it fades, but
      dithered.
    - A `Decal` on the card's face, on an invisible part: a clean fade that
      takes `Color3` and `Transparency`. It is projected across the box
      face, ignoring UVs, so this UV-laid texture lost the crescent's middle
      in a test slash.
  - The rebuilt slash uses two Neon crescents fading by part `Transparency`
    (core and glow) plus sparks.
  - With `RenderFidelity` Automatic the crescents drew as straight-sided
    wedges. `Precise` kept them smooth.
  - Side by side with the swept-trail slash, the mesh slash reads as a real
    sword slash.
  - The emit module now fades Decals on `Start` toward the same-named Decals
    on `End`.
- **Texture helpers:** reconsidered. Since `TextureID` ignores alpha, the
  useful texture for a mesh effect is a Decal drawn for flat projection, and
  that is a different helper from the UV gradient first planned.

### 3. Seeing motion: an effect contact sheet

Goal: a grid of frames of the effect as it runs in Studio, taken at fixed
effect times, returned as one image like the animation contact sheet.

- Capturing at real speed is presumed too slow, because each still is a
  plugin round trip. That has not been measured; open question 2 decides it.
- The candidate is **slow motion**:
  - set particle `TimeScale` low, for example 0.05, so a 0.5 s burst lasts
    10 s, and capture at fixed intervals;
  - drive mesh tweens and beam offsets from the reference module's own clock,
    which honours the same scale.
- **This forces a choice.** `TweenService` does not read `TimeScale`. Either
  every effect the agent writes runs on the module's clock, or slow-motion
  verification covers particles only.
  - Running everything on the module's clock is defensible: VFX Forge drives
    its own curves too. It does depart from plain `TweenService`, which
    constraint 4 would otherwise favour.
  - The user should make this call before step 3 starts.
- Try existing tools first. A playtest, `execute_luau` to fire the effect and
  `capture_screenshot` in a loop may be enough. A new operation is justified
  only if that cadence is too uneven.
  - If one is needed, add it as a mode on `capture_screenshot` or the
    `animation` tool. That keeps the tool count flat, but it still changes the
    public surface. Schema, handler, routing, plugin, edition allowlists,
    desktop risk and drift tests all have to be updated together.
- **Edition:** firing an effect and running a playtest change the DataModel,
  so the effect contact sheet is for the main edition only. The inspector may
  capture frames but must not fire effects.
- The grid is composed in core with the existing PNG encoder, and the
  timestamps are labelled.

Acceptance:

- frames are taken at the stated effect times, within a measured tolerance;
- the effect, emitters and playtest are cleaned up on every path;
- a known effect gives the expected grid: a ring that grows, a burst that
  fades.

### 4. Evaluation

Brief the agent on four effects: a sword slash, a fireball with a trail and
impact, a ground slam with a shockwave and cracks, and a heal aura. Score:

- layer count and which layer types are present;
- uploads used;
- particle rate and texture sizes against the budgets;
- whether the effect is client-rendered and pooled;
- whether a contact sheet shows anticipation, impact and dissipation.

Record the user's visual verdict beside the score. Quality cannot be unit
tested.

## Reference study of experienced artists' effects

Done 2026-10-02, after Roqer built a fire punch from the guidance above that the
user called generic and cheap. The user supplied a local collection of
effects by experienced Roblox VFX artists:
- 11 `.rbxm` and 10 `.rbxl` files, including Marcid's open-source slashes,
  Jaxelos's stars and cosmic impact, a Megumin explosion, orbs, magic circles,
  wind and smoke, water, and shape-and-value practice pieces;
- 9 showcase videos;
- an artist's source textures, with stylised wind meshes and their 30-frame
  texture sequences.

They are not in this repository.

### Method

- **Files:** the binary files were parsed offline and every property,
  attribute and script dumped.
  - Distributions were computed over all 3,950 particle emitters.
  - The script-driven, slash, orb and practice effects were each read in
    depth.
- **Textures:** the 144 most-used were rendered in a Studio gallery and looked
  at.
- **Effects:** several were rebuilt in Studio and captured frame by frame.
- **Videos:** each was cut into contact sheets, and its impacts stepped at
  30 fps.
- **Engine probes:** the behaviours the data only implied were probed in
  Studio with one test texture over a dark and a bright background.

### Findings

**Textures**
- 915 distinct textures; only 8 emitters use a Roblox built-in.
- Almost all are white, hard-edged, cel-shaded drawings on transparency.
- 46% of emitters play a flipbook, mostly 4 x 4, whose frames break apart
  rather than fade.

**Layers**
- 40-60 distinct layers make one hit in the slashes.
- The median `EmitCount` is 1, and 37% of emitters have Speed near 0: stacked,
  timed sprites.

**Value**
- 7% of emitters are pure black, and 10-35% in the value-focused pieces.
- Black is used as backing behind colour, as accents in front, and as twins
  that move differently.
- Impacts stack a colour copy, a black copy at `ZOffset` +0.25 and a white copy
  at +1.

**Brightness and blending**
- The median Brightness is 9.
- 39% of emitters use `LightEmission` 0, 35% use 1, and 10% are negative.
- Every studied place has Bloom at Threshold 2, the same as a new place.

**Orientation**
- 34% `VelocityPerpendicular`: flat rings and crescents in a fixed plane.
- 23% `VelocityParallel` with `Squash`: streaks.

**Timing**
- Flash and impact frames: 0.03-0.15 s.
- Crescents: 0.15-0.4 s.
- Rings and debris: 0.4-1.4 s.
- Smoke: 1-3 s.
- The median lifetime is 0.45 s.

**Videos**
- A one-frame overexposed star flash.
- Full size within two frames.
- About 0.6-0.8 s in total for a hit.
- Fire turns into dark smoke with glowing cracks.
- Anticipation before big hits.
- Scorch marks that linger.

**Conventions**
- `EmitDelay` is absolute. VFX Forge writes a group's delay onto every
  descendant; summing ancestors would double it.
- `EmitDuration` means "re-burst every 0.1 s" in some scripts and "Enabled at
  `Rate`" in others.
- `TimeScale_*`, `Size_*` and `Part_*` attributes are VFX Forge editor inputs.
- The Keyframe data in the slash places animates only the character rig. The
  effects are fired from Moon Animator markers.

### Verified in Studio

**Blending**
- At `LightEmission` 0, Brightness 5-150 renders a solid shape pushed toward
  white, which blooms.
- `LightEmission` 1 washes out over a bright background.
- Negative `LightEmission` (-1, -3) keeps the colour saturated and opaque over
  a bright background, with a dark rim.
- A black layer renders as:
  - solid ink at `LightEmission` 0;
  - a faint veil at 0.55;
  - nothing at 1.

**Other behaviour**
- `VelocityPerpendicular` at Speed 0 does not show; at 0.001 it lies flat.
- Transparency keys above 1 make a particle vanish early. Negative
  Transparency does not harden a soft texture.
- A Decal's `Color3` above 1 renders overbright and blooms.
- `Emit(0)` emits nothing.

### Roqer's fire punch, against this

- **Sheets:** Roqer made 8 x 8 sheets of soft, grey, rendered smoke with no
  silhouette, and the frames barely changed. (This first said each frame
  filled about 5% of its cell. A later measurement put their widest drawing
  at 39-62% of a cell. Size was not the fault; see the second study below.)
- **Meshes:** plain grey.
- **Result:** a generic glow, orange spikes and a brown cloud:
  - no flash frame;
  - no dark layers;
  - no hard silhouettes.

### What changed

- **Guidance:** `vfx-craft.md` is rewritten around the measured and verified
  findings, with the source of every number marked.
  - Layer skeletons replace the built-in-texture recipes.
  - Two earlier claims are corrected: that additive textures need a black
    background, and that soft shapes read as magical.
- **Drawing helpers:** the Blender worker gains `roqer.draw_flipbook`,
  `draw_texture` and 2D primitives (`tex_coords`, `tex_polar`, `tex_noise`,
  `tex_cells`, `tex_sample`, `tex_edge`, `tex_ease`) for drawing stylised
  textures with numpy.
  - The worked examples in `blender.md` were run verbatim in Blender 5.2: two
    sheets and a texture in about 5 s.
  - `roqer.flipbook` now defaults to a 4 x 4 grid.
- **Flipbook check:** Roqer noted a sheet whose drawing spans under 40% of a
  cell at its largest frame. This was removed after the second study: it
  would have flagged most of a professional hand-drawn set and missed Roqer's
  own sheets.
- **Emit module:** the handle's time scale multiplies each emitter's own
  `TimeScale`, so artists' slowed smoke keeps its pace, and the authored value
  is restored afterwards.
- **Checked live:** the reference's JSON examples, built verbatim as one
  effect, play in Place1 as designed. The sequence is an anticipation point, a
  one-frame star flash, a hot core with a dark rim and streaks, then a ground
  ring and smoke.

### After a second run

The same brief, re-run on the new guidance, produced a different effect. It
had drawn textures, cel smoke, glowing branching cracks, ground slabs, a
wind-up and a flash, and the user called it a better direction. Four faults
remained:
- **A white blob at the core.** The data shows pure-white layers are thin
  shapes at Brightness 1-2, about as big as the coloured layers; the hot centre
  is a coloured layer at high Brightness.
- **A large half-transparent dome.**
- **Smoke in one flat tone.**
- **A light that tinted the whole floor.**

The guidance now covers each one, and they are added to its checking
questions.

The run also used 10 uploads, one wasted on a texture it then redrew. So
previewing a texture in Studio without uploading was tested (2026-10-02, edit
mode):
- An `EditableImage` made by `AssetService:CreateEditableImage` and filled with
  `WritePixelsBuffer` shows on a `Decal` and an `ImageLabel` through
  `TextureContent` and `ImageContent`.
- `ParticleEmitter.TextureContent` and `Beam.TextureContent` accept it. The
  particle draws nothing, even after re-emitting, and the beam draws a plain
  white strip.

So a true particle preview cannot come from memory today.

The content folder was then tried, with the user's consent, and adopted:
- A PNG copied into `content/textures/roqer-preview` loads as an
  `rbxasset://` address with no restart, and plays as a flipbook.
- An overwritten file keeps showing its first image, so each job's files get
  new names.
- The Blender tool's `preview_in_studio` flag does this
  (`runtime/studio-preview.ts`, documented in `docs/blender.md`). It was
  checked end to end: a real job's sheets were staged into the real install
  and played on a particle in Place1.

The two ways considered:
- **A stand-in card:** a billboard `ImageLabel` stepping through the sheet's
  cells. It shows shape and timing, but not particle blending, Brightness or
  bloom.
- **Studio's content folder:** files there load as `rbxasset://` and render as
  real particles. Writing there changes the user's Roblox install, so it needs
  their consent, and a Studio update removes the files.

### Next

- **Camera, screen and debris effects:** the studied scripts add camera shake
  presets, impact frames (ColorCorrection), light flashes and ground-sampled
  crater rings. The guidance documents them with numbers; the emit module does
  not do them yet.
- **Proof:** re-run the fire-punch brief in Roqer and compare against the
  study. That needs the user's look, and texture uploads only with their
  approval.

## Second reference study: design

Done 2026-10-02, with a second collection from the user:
- 27 Roblox files: skills, showcases, practice pieces and asset packs;
- a hand-drawn texture set of 49 sheets, by Qwinkle;
- a captioned tutorial video by the artist snaliel.

The aim was design: what each effect is for and why it looks as it does.

### Method

- **Files:** dumped as before. Three parallel readings covered the beam and
  projectile skills, the character skills and showcases, and the practice
  pieces with the texture set.
- **Textures:** the 168 most-used were rendered in a Studio gallery.
- **Effects in Studio:** some practice pieces and Reversal Red were rebuilt in
  Place1 and captured.
- **Video:** the captions were read frame by frame.

### What the effects are

| Effect | Kind | What it is |
| --- | --- | --- |
| AbyssalRay | Ultimate | A dark summoning-circle beam: 7.5 s root, two implosions, black and white impact frames, then a 0.25 s beam sweep with a crater |
| beam | Held beam | A Kamehameha-style hand beam |
| fiya beam | Held beam | An overhead fire cannon |
| firedragon | Summon | A Katon fire dragon, homing on a Bezier path |
| Fireball | Ultimate | A meteor ultimate |
| Flame Beziers | Barrage | Fire missiles |
| Water Barrage | Volley | A Gate-of-Babylon portal volley |
| Mildly wet projectiles | Basic skill | Water projectiles on a one-second cooldown |
| Missile Sequence | Showcase | An arcane star barrage between staged cubes |
| Ayato | Showcase | A five-hit sword combo and a dash, hand-timed to a 3.2 s animation |
| Healing | Practice | An A/B of pulsed bursts against a continuous stream |
| teleport | Kit | A glitch blink |
| Petal Pathway | Showcase | A traversal path |
| Reversal Red | Fan move | Gojo's Reversal Red |
| Colouring Practice | Practice | Colour |
| Constellations | Practice | An A/B of a halftone overlay |
| Pink and Blue | Practice | A two-hue aura and hit |
| Magic Missiles | Practice | One recipe recoloured four ways |
| orb thingies | Pickups | Three orbs differing only in colour |
| Jaxelos explosion | Showcase | A staged mega-explosion with colour-correction frames |
| VFX_MASTERSTUDY | Study | A two-hit study timed with Moon Animator, with camera FOV keys |

The rest are mesh packs and Part_Icles mesh-particle, trail and lightning
rigs.

### New findings

**Palette and colour:**
- Many skills are a single hue, with value from Brightness, dim twins and a
  dark gradient tail.
- Two-hue effects use analogous hues about 45-50° apart; a complementary
  accent stays at about 10% of layers.
- The tutorial says: choose about five colours and never break the palette,
  and pair saturated energy with desaturated debris and smoke.

**Value without black:**
- a Brightness 0-0.01 white sprite;
- same-hue dim twins;
- a gradient that runs to near-black at `LightEmission` 0;
- a white base under additive colour;
- inverted value for dark energy: a black core in front of a white halo.

**Timing:**
- The tutorial's intensity curve: one emit, with layers dying in order. Key
  poses only get less intense: the flash with wind, then the scatter, then
  the residue.
- Cause and effect are staggered.
- Shockwave rings are thin Neon discs that grow in 0.2 s while fading.
- Hit, hold, then a hit 1.6-1.8 times bigger about 1.4 s later.
- Impacts fire 0.1 s before a projectile arrives.

**Construction:**
- Projectile anatomy: a head, 2-3 trails, and shed particles.
- Slashes drawn in time, with points along the arc delayed 0.04-0.05 s apart.
- Held beams: 2-3 Beams with unsynced scroll, plus Rate-driven streaks.

**Camera, screen and world:**
- FOV pulls back while charging and snaps at release; blur, tint, and black
  and white impact frames.
- Shakes are rotation-only and gated by distance.
- Lights expand their Range while dying.
- Craters copy the floor's material and colour.

**Bloom and textures:**
- Bloom thresholds in these places run 1 to 2. Brightness is relative to the
  place's bloom.
- The hand-drawn textures are white with binary or posterised alpha, take
  their detail from negative space, and grow then fragment.
  - Their shapes are small in the cell: the widest drawing's median is 27% of
    the cell, and 40 of 49 are under 40%.

### Corrections

- **The small-drawing note is removed** from Roqer's flipbook check. It would
  have flagged most of the hand-drawn set, while the sheets it was written for
  measured 39-62% and would not all have been caught.
- **The guidance now says size in the cell varies,** and names what made
  Roqer's first sheets generic: softness, grey, no silhouette, and frames that
  barely changed.
- **The study's own attribute decoder** read colour and number sequences in
  attributes in the wrong field order (the envelope comes first). It is fixed;
  the first study's conclusions did not rest on those values.

### What changed

- **`references/vfx-design.md` (new):** what the effect is for; palette;
  value; brightness against the place's bloom; textures; layers; the intensity
  curve; motion; projectiles, slashes, beams and sustained forms; camera,
  screen and world.
  - It combines both studies and the tutorial.
  - `vfx-craft.md` keeps the engine, tools, skeletons and checking, and points
    to it.
- **`references/blender-vfx.md`:** describes hand-drawn texture traits and
  drops the cell-fill claims.

## After the ice spear run

A third brief tested the new guidance: an ice spear for an anime battlegrounds
game.

**What improved:**
- the palette held: five named colours, with cobalt and navy as the darks;
- the shards were cel-shaded with lit and shadow faces;
- textures were previewed in Studio and redrawn before upload, and only the
  settled set of 7 was uploaded.

The user called it a lot of progress, but not yet top notch.

**What still separated it from the references:**
- **Textures looked like clip art:** a perfectly radial impact star with even
  outlines, a snowflake-symmetric frost patch, and a ring with gear-like
  notches. The drawing helpers made geometry easy (polar rays and rings) and
  gave nothing for drawn shapes.
- **Little speed:** the spear was a thin sprite in flight, with few streaks
  and no wind rings or smears.
- **The core blew out:** a white blob again, pale on a light floor.

**Changed:**
- **Four drawing helpers:**
  - `tex_curve`: smooth paths;
  - `tex_stroke`: tapered brush strokes along a path, drawn on and erased by
    `start` and `end`;
  - `tex_blob`: lumpy, lopsided blobs;
  - `tex_warp`: noise-warped coordinates.
- **New examples in `blender-vfx.md`:** a claw slash, a lopsided cel-shaded
  puff, a splinter burst and branching ground cracks. The radial star and the
  Voronoi lava cracks are gone. The examples ran as written in Blender 5.2,
  and look close to the hand-drawn set's claws, puffs and cracks.
- **A "does it look drawn" checklist** in `blender-vfx.md`.
- **Speed carriers** for anything that moves, in `vfx-design.md`.
- **New checks in `vfx-craft.md`:** clip-art textures, floating projectiles,
  and a pale effect needing its darks on a light floor.

## After the second ice spear run

The same ice spear brief, run after the stroke helpers. The user: the charge
on the hand was the best part; the impact and explosion "look bad", nowhere
near the dump.

**What was measured.** The shatter was rendered on the study stage with the
same camera and timings as the dump's explosions, then from the caster's
camera 50 studs away. Its numbers were compared with 26 impact groups from
both dumps (deduplicated):
- **Size class:** the shatter's largest layer was 13 studs (30 for a ground
  ring). By screen area over time it sat with the dump's single arrow and
  barrage hits (peak 400-1,000 size² units), not with its explosions
  (4,000-25,000 for practice pieces, 480,000 for a meteor slam).
- **Distance:** from the caster's camera the shatter was a speck. Roqer's
  own checks framed it close, where it filled the view. The craft guidance
  told it to "frame close".
- **Size numbers:** the dump's largest layers (10-13 studs for one hit of
  many, 70-360 for a whole-skill projectile) are mostly flashes, flares and
  shockwaves at full size for a fraction of a second. Solid bodies are
  smaller (crescents 19-125 studs).
- **Brightness:** Place1's bloom threshold is 2. Every impact layer but a
  0.08 s flash sat at Brightness 1-3, so the shatter read as flat paint. The
  dump's impacts peak at Brightness 15 (median) and 50 or more in a third.
  The guidance's "most layers sat at 3-10" was read as applying to the hit.
- **Growth:** the shatter's mass peaked at +0.1 s and only shrank. Seven of
  nine dump explosions and slams kept growing 0.25-1.35 s after the hit. The
  guidance's "nothing gets bigger" rule said the opposite.
- **Flat:** apart from a 6-stud spike mesh, it spread on the floor. The frost
  patch was even Voronoi cells, which read as tiles.

**Experiment.** The same shatter with sizes and speeds ×2.5 and its hot
layers at Brightness 12-60 read as a burst from the caster's camera, and was
overblown close up. Size and brightness are most of the gap. It still read as
a splash rather than an eruption, so the rest is design: something must rise.

**What changed:**
- `vfx-design.md` section 1: size the payoff for where it is seen, with the
  measured size classes; a flat impact shrinks to a smear at range.
- Section 4: the hit's hottest layer runs Brightness 15-50+, apart from the
  3-10 of trails and smoke.
- Section 7: brightness falls, but an explosion's mass grows for 0.25-1.35 s;
  the flash is the biggest thing in its frames.
- `vfx-craft.md` section 8: capture from the player's camera as well as
  close, and check size share, bloom and rise.
- `blender-vfx.md`: even cells as a whole shape read as tiles; ground marks
  spread from the point of impact.

## After the third ice spear run

The user: "looking better once again". Roqer checked the impact from the
caster's camera this time, sized it up (a 30-stud flash at Brightness 25, a
22-26-stud star, a 40-stud ground ring, upward spires) and it reads from
range.

**What still separates it from the dump:**
- **A pop, not a swell.** Its screen area peaks at about 2,600 (size² units)
  by +0.1 s, three times the previous run, but falls to a third by +0.25 s.
  Its star body lives 0.16-0.2 s; the dump's explosion bodies live 0.35-1.2
  s. What remains is 40 shards of about 2 studs, which reads as a sparkler
  from the caster's camera.
- **The flash** is a thin four-ray flare at 30 studs. Rotated, it shows as
  two white beams in a V.
- **Overbright decal colour** was refused by `build_instances`, whose
  `color3From` (`studio-plugin/src/modules/Utils.ts`) takes components from
  0 to 1 only, on purpose, to catch 0-255 values. The guidance asked for
  `Color3` 2-20 on decals without saying how. It now says to set it with
  `execute_luau` after the build.

Considered and dropped: reporting each flipbook cell's drawing span. The
star's spikes span 70% of its cell, so the span was not what made it read
small.

**What changed:** section 7 of `vfx-design.md` names the body layers and their
measured lifetimes, adds a lifetime row, and says a flash's body is a filled
shape. `vfx-craft.md` adds a check for the body at 0.3 s, and the overbright
decal route.

**Follow-up:** `draw_texture` images are not checked at all. Only flipbook
sheets are.

## The magic missile run, and what a run costs

The user: "looks actually pretty good", but the missiles' trails are bad, and
the run used 13% of a Max 5x session.

**Trails.** In the run's screenshots they are thin, uniform-width white
lines: no taper, no coloured or dark body, nothing shed. Roqer never saw them
in a capture. Pausing discards a trail's segments, and at 0.04x it captured
before the missiles had moved. Its own module moved the missiles, and may not
stretch trail lifetimes when slowed.

**Cost.** Run records keep no token counts. Claude Code runs with
`--no-session-persistence`, and the planner reads `modelUsage` only for the
context meter. So the following is an estimate. The run made 96 Studio and
Roqer tool calls, about 115 model requests, and each request re-reads the
whole conversation:
- About 40 of those calls were the pause, capture and resume loop: 16
  screenshots and 25 runtime evals.
- 16 screenshots reach the model at full size (2246 x 982, which Claude Code
  passes to Opus 5.5 at 2000 x 874, about 2,300 tokens each; first estimated
  here at 1,400 on a 1568-pixel premise, corrected after run 3). Each stays in context for the rest of the
  run.
- The first three calls read 820 lines of existing modules, including Emit,
  which the skill ships.
- Not a cost: the `get_script_source` rows after each write are Roqer's own
  read-backs, which never reach the model.

**Changed now:** two calls a moment instead of three; pick 4-6 moments; the
trail wait (effect seconds ÷ 0.04) and the lifetime stretch in a module of
the agent's own; Emit's first line carries a version, so an existing copy is
checked from one line.

**Proposed:**
1. Record each run's usage (`usage`, `num_turns`, `total_cost_usd` from Claude
   Code's `result` event) in the run record, with the migration and
   validation a stored schema needs, so savings can be measured.
2. A Roqer operation that captures several moments of a playing effect in one
   call: slowed rather than paused for trails, N images in one result.
3. Then, once measured: smaller screenshots, and the model and effort dials.

**Trails, read from the saved place.** The missiles play through the emit
module, so their trails were stretched when slowed; that was not the fault.
`TrailCore` is 0.32 studs wide and lives 0.22 s; `TrailBody` is 1.7 studs,
mostly transparent. What the missile sheds is 0.25-0.28 studs. The studied
missiles run 2-3 trails across about 5 studs, a dark or wide body under a hot
core, and shed particles at around 100 a second. The guidance says so; Roqer
never saw its own trails to compare.

**Built: `capture_moments`** (`runtime/capture-moments.ts`), offered inside
`roblox_studio` as a gateway operation (`shared/gateway-operations.ts`):
Roqer composes it from `execute_luau` or `eval_client_runtime` and
`capture_screenshot`. One call runs the code that starts an effect, plays it
slowly to each requested time (at most 20 s of real time per moment), holds it
or, with `hold: false`, keeps it playing for trails, captures, and returns up
to 8 frames in one result. It stops the effect afterwards, after a failure or
cancel too. It is classified irreversible like the calls it is made of, and
the approval card shows its code. `vfx-craft.md` section 8 now checks effects
with it.

**Checked live** in the user's saved missile place (2026-10-02):
- Held: the final blast at 0.05, 0.15, 0.35, 0.6 and 4 s. Five frames came
  back in one call, the last one empty after the effect ended.
- Not held: a full cast at 0.04x. The missiles' trails show, as they never
  did in the run's own captures.
- A caster-to-target marker viewed from the caster's side puts the camera
  about where the player's is.
- Workspace was left as it was.
- The wait now gives up once the effect's clock has stood still for 1.5 s; it
  used to sit out its 20 s cap after the effect ended.

**Magic missile, run 2 (first measured run).** 25% to 34% of a Max 5x
session, against 13% for run 1; 102 steps against 141; 71 tool calls against
96, 9 of them `capture_moments`. The usage line: 12.5M tokens read from
cache, 337k written to it, 153k output, 81 requests, about $8.27 at API
prices. Run 2 also carried the other guidance changes (two calls a moment,
Emit's one-line check, not reading other effects' code) and two playtest
start timeouts, so the saving is not the capture operation's alone.

*Corrected after run 3:* an earlier version of this note put cache reads at
about half of run 2's cost, and its frames at about 1,400 tokens each. Both
were wrong. Claude Code's model
table prices Opus 5.5 at $4 per million input tokens, $20 output and $0.20
cache reads, and run 2's $8.265385 reproduces exactly with cache writes at
$8, the one-hour rate. So run 2 was 30% cache reads ($2.51), 33% cache writes
($2.70) and 37% output ($3.06), not "about half" cache reads. Its frames were
estimated at about 14% of its cost.

**Contact sheet.** `capture_moments` now returns its frames tiled into one
image, two to a row (`composeContactSheet` in `electron/image-encoder.ts`,
using `nativeImage`). `sheet: false` returns full-size frames. The eval
harness runs without Electron, so it gets separate frames. *Corrected after
run 3:* the first version was 1568 pixels wide, on the premise that the
provider scales any image to about that size. For Opus 5.5 that was wrong:
Claude Code passes images up to 2000 x 2000, so run 2's frames reached the
model at 2000 pixels and the 784-pixel tiles had 6.5 times fewer pixels. The
sheet is now 2000 pixels wide (1000-pixel tiles).

**Follow-up (bridge):** while Studio was not drawing frames,
`capture_screenshot` first refused ("window appears minimized or not
rendering"), then returned frames that were 46 minutes old, from an earlier
playtest, without an error. A stale frame should be refused too.

## Magic missile run 3: why it looked worse

The same prompt a third time. The user: "way worse". It also cost more: 16.7M
cache reads, 299k cache writes, 175k output, 102 requests, about $9.23
against run 2's $8.27, and it ended unverified.

**What was compared.** Run 2's and run 3's `VFX` folders were exported from
the user's saved places and played side by side in Place1, on one stand-in
R15 caster, from the same cameras, at each version's own beats. Five
independent analyses covered the evidence images, the textures, the process,
the contact sheet and the playtest failures. Their load-bearing claims were
checked against Claude Code's logs and binary, Studio's logs and the code.

**How run 3 looks worse** (live, same conditions):
- **Sigil:** a 9-stud root with rune rings growing to 15 studs, thin line art
  around the whole caster; run 2's is about 5-6 studs, compact and saturated.
- **Missiles:** small white sparks with soft ribbons; run 2's are bright
  shards with white cores and magenta ribbons.
- **Finisher:** run 2 has a 30-40-stud light lance, crystal spires, crescents,
  dark violet dust smoke for 1.2-1.7 s and a ground sigil. Run 3 has a small
  flash, a camera-facing ring growing to 42 studs (a pale shell), a swirl of
  claw strokes up to 46 studs and no smoke.
- By the screen-mass metric, run 3's finisher is as large and lasts as long
  (peak about 8,500 against 9,100). The metric counts each particle's quad;
  thin claws and translucent rings fill little of theirs.

**Why** (most to least weight; one sample of each run):
1. **Design choices made before any capture.** Run 3 drew 8 textures to run
   2's 11, as geometric polar and segment shapes. Its scripts call `tex_warp`,
   `tex_blob` and `tex_curve` 0 times, against 4, 3 and 3 in run 2. It dropped
   run 2's cel smoke puff (its only matter layer) and loose rune glyphs, used a
   static 1.4%-wide ring on 10 emitters, and arranged its claws evenly around
   the centre. The guidance was identical, so this is model variance. Commit
   f2c9b03 cannot have caused it: every texture was drawn before the first
   capture.
2. **Its checks were weaker.**
   - **Playtests wedged.** The agent sent `stop` and `start` in one batch.
     Studio refused the start while still stopping ("already in transition
     StoppingPlayTest") and then refused every later start ("a previous one is
     still in progress"). The plugin returned `success` before Studio started
     (`TestHandlers.startPlaytest`) and only `warn()`ed the error, so each
     retry waited out a timeout. Several open Studio windows were not the
     cause. Run 3 then tuned on a stand-in in the edit viewport and never saw
     its final version on the character.
   - **Claude Code cut every call at 60 s** (`timeoutMs: 60000` for HTTP
     servers). Captures over 60 s and long playtest waits never reached the
     model, though Roqer recorded them as successful. A trail capture
     (`hold: false`) played the whole effect at 0.04x and always ran past 60 s,
     so neither run's model saw its trails in flight.
   - **The Blender result attaches at most 4 plain PNGs, by sorted name.** Run
     3's spark had no preview until a third job, and its own review sheets
     (`zz_review_*`) were never shown to it.
   - **The contact sheet** showed every run 3 frame at 784 pixels against run
     2's 2000. Plausible, not shown: the agent still caught the obvious
     problems.
3. **Process variance.** Run 3 tuned in a playtest first. Its accumulating
   camera shake moved the playtest camera. Its first arm fix (turning the
   `AnimationConstraint`'s attachment) did nothing. And it edited the module
   after uploading, so the completion gate asked for a fresh look.

**Cost:** +21 requests at peak context (the playtest wedge, arm and camera
debugging, the gate's re-capture) explain the extra cache reads. The contact
sheet lowered image cost (estimated about $0.30 against about $1.93 for the
same frames sent alone).

**Changed:**
- Claude Code gets a 24-hour tool-call timeout for Roqer's server (the
  per-server `timeout` key), so Roqer's own budgets, approvals and cancellation
  decide. Its automatic backgrounding of MCP calls running past two minutes
  (on when a user sets `CLAUDE_AUTO_BACKGROUND_TASKS`) is turned off with
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`.
- `capture_moments`:
  - It plays at normal speed and slows down only for the last stretch before
    each moment. For trails that stretch is 0.9 s of effect time, longer than
    any studied trail lives, but never more than one wait covers.
  - A capped wait continues in another call.
  - It keeps within its call budget and names the moments it had no time for.
  - It no longer rescales an effect that has finished. Emit's
    `setTimeScale` now refuses too, so its version line is 2026-10-03.
  - Checked live: a 3-moment trail capture reached every moment in 34 s with
    full trails, and an 8-moment held capture took 23 s instead of 35 s.
- The contact sheet is as wide as a frame sent alone would reach the model, at
  most 2000 pixels, so each tile is half that width and a frame is never
  enlarged. Eight 2246-pixel frames make 2000 x 1744 at 327 KB.
- Guidance:
  - tune in the edit viewport;
  - take the final look as full-size frames from the player's camera;
  - camera shake takes its offset back off;
  - pose an `AnimationConstraint` joint by writing `Transform` in
    `PreSimulation`;
  - never batch a playtest stop with a start, and stop retrying after one
    failure.

**Follow-ups, not done:**
- **Plugin and bridge:**
  - `stop` should wait out Studio's stop transition before returning;
  - `start` should fail with Studio's own error instead of reporting
    success;
  - readiness should be tied to the start that asked for it (run 2's call 50
    reported a session the bridge had not started).
  These need the live suites.
- **Blender worker:** stage previews for every texture, attach the agent's own
  review sheets, and name the PNGs not attached.
- **Texture checks:** report thin line art that will not survive distance
  (survival under a 1% erosion: run 3's rune ring 0.00, run 2's smoke 0.88)
  and radial arrangement, so the agent sees them as numbers.
- **The camera skill's shake recipe** pins the camera to where the shake
  began, which fights a following camera.
- **Per-request usage** is not kept, so where context grows can only be
  estimated.

## Texture study: light and drawn matter

Done 2026-10-04, after a void-slash run drew its four-point flare as four
bent strokes of different lengths around a lumpy blob, cut hard, with a glow
pasted underneath. The user asked why it looked weird. The cause was the
guidance: "Not symmetric, not even… not as rays and rings around a centre"
and "Hard edges… only an accent texture or two is soft" applied to every
texture. The run followed them. The same chat's first version, a cross
flare, was built the same way.

### Method

- **Files:** the 47 place and model files of the user's collection were
  parsed again. They hold 5,803 texture uses (4,950 particle emitters, plus
  beams, trails, decals and meshes) and 1,438 distinct textures.
- **Pixels:** every texture was fetched from Roblox's public thumbnail
  service, which serves an image asset as a 420 px PNG with its alpha and
  needs no login. Asset delivery at full size now requires authentication.
  1,431 came back; 5 are blocked by moderation and 2 were still pending.
- **Measured per texture:** how far faint alpha reaches past the shape's
  0.5 outline (about 1 px for a crisp edge at any thickness, tens of pixels
  for a glow), mirror and radial symmetry, and, for flipbooks, each cell's
  coverage, pieces and mean alpha. Each use was joined with its emitter's
  `LightEmission`, `Brightness`, `Lifetime`, `Squash` and `Rotation`.
- **Kinds** come from the emitters' and their parents' names (flare, shine,
  glow, ring, burst and so on), which is approximate. The 19 four-point
  flares were picked by eye from contact sheets of the flare, shine and
  flash kinds.
- **Limits:** 420 px is resampled from the 1,024 px originals, so this
  cannot check the hand-drawn set's posterised alpha, and an 8 x 8 cell is
  only 52 px.

### Findings

- **The blend predicts the edge.** At `LightEmission` 1, 83% of 1,734
  emitters use a texture that falls off softly. At `LightEmission` 0, 57% of
  2,440 use a crisp or nearly crisp one. Flipbook emitters are 65% crisp or
  nearly crisp; single-image emitters are 77% soft.
- **Four-point flares (19, on 124 emitters):**
  - 16 have four straight arms of the same length within 4%. The others are
    a tiny glint, a horizontal lens streak, and one with a longer lower arm.
  - 16 fall off softly and 2 are crisp concave-sided stars. Each arm thins
    and fades toward its tip from one smooth core.
  - None has bent arms or a lumpy core.
  - The emitters stretch them: 41% squash the flare, against 21% of
    emitters on other soft textures. Rotation is not special: 75% rotate it,
    against 86% of all emitters. They live a median 0.35 s (0.49 s across
    all emitters), mostly at `LightEmission` 1 and Brightness 5-12.
- **Round soft glows** (436 emitters) run at a median Brightness 2, and 39%
  at 1 or below.
- **Drawn matter holds the old description:** crescents, cel bursts,
  splashes, debris and puffs are crisp, lopsided and two-toned.
- **Flipbooks (463 one-shot sheets):** 57% break apart, 15% shrink and fade,
  6% erode in one piece. Coverage peaks a median 27% of the way through, and
  half end in blank cells. 4 x 4 is on 81% of flipbook emitters.
- **Decals:** one splash is 16 Decals swapped frame by frame on a part.
  Ornament and magic-circle decals are symmetric.

### Corrections

- "Almost all are white, hard-edged, cel-shaded drawings" (first study) was
  from the 144 most-used textures viewed by eye. It holds for drawn matter
  and for most flipbooks, not for the textures as a whole: light is soft.
- "Glows, flares and halos: `LightEmission` 1 at Brightness 0.05-1" holds for
  glows only. Flares run at 5-12.

### What changed

- **`vfx-textures.md`:** textures are split into two families, drawn matter
  and light. Light keeps its symmetry, as symbols do: a four-point flare
  mirrors on both axes with equal arms and one smooth core, and the
  emitter's `Squash` stretches it. The drawing pattern and the checklist
  say which family they apply to. Two flare examples were added (a soft
  glint and a crisp concave star), written in plain numpy and run in
  Blender 5.2 with the repository's helpers; they match the studied flares
  side by side.
- **`vfx-design.md`:** the fourth study, and flare and glow brightness. The
  blend-edge rule lives in `vfx-textures.md`: `vfx-design.md` and
  `vfx-craft.md` load together in one call, capped at 48,000 characters
  (`MAX_BATCH_CHARACTERS`, enforced by `vfx-craft.test.ts`). That call now
  returns 47,843, leaving 157 characters (about 400 before this change).
  The next addition to either file needs content moved to a topic file such
  as `vfx-textures.md`, not a higher cap.
- **`vfx-craft.md`:** the hard-silhouette and clip-art checks now say they
  are for drawn shapes, and ask about a flare's arms and core.

**The helpers were not changed.** They are thin numpy primitives and forbid
nothing. What steered two runs to the same broken flare was the
documentation around them: every example was drawn matter, the one pattern
was "draw, make it lopsided, cut it hard", and light was named only as the
thing not to draw ("rays and rings around a centre"). The guidance now says
the helpers are shortcuts for drawn matter and shows light written directly.

## Fifth study: explosions and smoke

Done 2026-10-11. The user reported two problems with the effects runs build:
- explosions that are "just a static image growing, not a flipbook";
- smoke that is sometimes deep black and feels off or cartoonish.

### Method

- **Files:** the same collection: 47 files plus a preview rig from its nested
  zip, 5,010 particle emitters.
  - They were parsed with a new reader for the binary format.
- **Textures:** 1,432 textures. 1,427 came back from the public thumbnail
  service at 700 px, against 420 px before; 5 are blocked by moderation.
  - Each was measured for value, inner contrast, saturation, edge softness
    and per-cell coverage.
  - Galleries of the smoke, fire-body and static fiery textures were looked
    at.
- **Videos:** the 6 explosion videos were stepped at 10-30 fps.
  - Smoke darkness and the handover from fire to smoke were measured from
    pixels against an empty frame of the same shot.
- **Classification:** layers were picked out by name (smoke, fog, dust, …),
  by colour (warm, saturated and bright for fire), by size, life and texture
  edge. The effects behind the main numbers were read by hand.
- **Not checked:** nothing in Studio.

### Findings

- **The mass is a flipbook.**
  - Of 297 fiery layers big enough to be a body, 152 are flipbooks. Of the
    145 single images, 138 are soft light (glows, flares, streaks, rings) and
    2 are drawn shapes.
  - The fire bodies are 4x4 drawn or 8x8 rendered sheets: 1-7 layers of 3-28
    particles, bursting out at Speed about 88 against Drag about 3, at random
    angles.
  - Brightness is about 5 at LightEmission about 0.2. The colour cools in
    its own hue: 73% end deeper red, 24% grey, 3% black.
- **Timing (videos):**
  - The fire body runs 0.05-0.33 s after the flash.
  - The burn-out (a charcoal core with glowing cracks) runs 0.3-0.5 s and is
    the darkest moment, near-black for 0.1-0.3 s.
  - Smoke peaks at 0.33-0.6 s, covering half the fire's area or less.
  - A stylized blast is gone by 0.6-1.2 s; realistic smoke lingers 2-3 s.
- **Smoke fires in the same burst as the fire** and outlives it: by up to 1 s
  in a hit, 2-11 s in a slam.
- **Smoke (320 layers):**
  - 68% self-lit (`LightInfluence` 0).
  - Rendered value about 0.7, mid to light grey.
  - At its most solid, a median Transparency of 0.59.
  - 72% soft or mottled; cel puffs about half transparent.
  - Median life 1.0 s.
  - 40 dark layers are veils (median peak Transparency 0.5); one is dense,
    in an ink-styled piece. In the videos, smoke darkens what is behind it by
    0.05-0.2 in luminance.
- **Value is Colour × Brightness.** The artists' dark hex values mostly sit
  at high Brightness: `#3f3f3f` smoke at 5-16, `#2b190c` fire ends at 15-65.

### Corrections

- **"Fire gradients end in black":** 124 of the 139 black-ending fire
  layers are in one effect's slash fire. Across 1,391 fiery layers, 87% stay
  in hue. 82% of black ends are on sheets already broken into fragments.
- **"Smoke reads better lit by the scene (`LightInfluence` 0.35-1)":** most
  of the scene-lit smoke is one piece, at 30-40% opacity and LightEmission
  0.55.
- **The smoke example** (LightEmission 0, LightInfluence 1, colour 0.32
  grey, Transparency from 0.2) made an 80%-opaque dark puff.
- **The impact skeleton had no fire-body role,** and its colour example was a
  static built-in puff scaled from 6 to 12.
- **Smoke lifetime** is 0.5-1.5 s in a hit, not 1-3 s.
- **Fire-body Brightness** is about 5. The 25-100 at LightEmission -1 to -5
  comes from two pieces.
- **Rocks fall** at -60 to -200, not -15 to -27. 20 layers get their
  variety from a sheet of variants with `FlipbookStartRandom` and `Loop` at
  0 fps.
- **Custom flipbook layouts** are on 368 emitters (7%).

### What changed

- **`vfx-explosions.md` (new topic):**
  - the mass as a flipbook;
  - the anatomy and timing;
  - the fire body with an example;
  - fire to smoke and a burn-out example;
  - smoke with a corrected example;
  - drawn fire-burst and burn-out sheets;
  - checks.

  The two drawings were run with the repository's numpy helpers outside
  Blender and checked tinted. They were not run in Blender, and none of the
  examples were built in Studio.
- **`vfx-craft.md`:**
  - the skeleton gains a fire-body row and a corrected smoke row;
  - the smoke example moved to the new topic;
  - the built-in textures are named as single images;
  - one check is added.
- **`vfx-design.md`:** the corrections above.
- **`vfx-textures.md`:**
  - smoke style shares;
  - variety sheets;
  - the Custom layout note.
- **Routes:** an explosion's route (the core pair, textures, explosions,
  camera and world) arrives in two calls.
  - The core pair's call is 47,499 of 48,000 characters, against 46,952
    before.
  - `vfx-craft.test.ts` holds the new route.
- **To check in Studio:**
  - how Brightness combines with `LightInfluence` above 0;
  - that Custom layouts play;
  - the new examples, built as one effect.

### After the first fireball run

The fireball brief on the new guidance gave the effect we were after:
- a flash, a spiky burst, boiling fire, fragments and smoke;
- gone by 2 s.

The user called it better. The impact-star sheet still looked weird.

**What the sheet did:**
- **It grew, then held.** It was a round puff with about nine straight
  spikes spread evenly, full size by cell 4. Cells 4-12 kept that one drawing,
  the outline moving 3-9% a frame (median 9% over the sheet), before it broke
  up.
- **It read as a comic sticker.**
- **The check stayed silent.** Roqer's sheet check flagged only
  byte-identical cells, so it said nothing.
- **Measured the same way, studied sheets move far more** (frames compared a
  4 x 4 frame's time apart):
  - 455 one-shot sheets: a median 44% a frame;
  - impact stars 40%, fire 34%, smoke 30%.
- **The 5% that hold** are nearly all rings, cracks and glows that only fade.
- **The 18 studied impact-star sheets** mostly burst open: shards fly out and
  the centre empties into a ring, or a four-point flare turns. Their last
  drawn cell comes a median 73% of the way through.
- **Likely contributors:**
  - the flash is described as "a filled spiky shape… solid at the centre";
  - the skeleton said only "a spiky 4 x 4 sheet";
  - the new fire burst drew tongues from a blob's rim and reached full size a
    third of the way in;
  - the new burn-out's outline held for nine frames, moving 3%.

**What changed:**
- **`runtime/flipbook-sheet.ts`:**
  - The check compares each frame's body (alpha 96 and above) with the next,
    a 4 x 4 frame's time apart, over the cells where the drawing is at least
    half its largest.
  - When the median change is under 12% and half the steps are, it notes the
    stretch with its numbers, as `heldStretch`.
  - In the TypeScript check it fires on the agent's sheet. Its Python
    calibration flags 5% of the studied sheets.
  - Empty cells no longer count as repeats, so a burst's blank tail is not
    "holding".
- **`vfx-textures.md`:**
  - every frame changes shape (with the numbers);
  - how impact stars burst, and that the flash is a different layer;
  - an impact-star example that opens into a ring of shards (78% a frame);
  - the change check asks about a held middle;
  - duplicated preview and upload advice was merged to make room.
- **`vfx-explosions.md`:** the fire burst and burn-out keep moving (30% and
  20% a frame).
- **`vfx-craft.md`:** the impact-stars row says the sheet bursts open.
- **Checks:**
  - All three examples were run with the helpers in numpy outside Blender.
  - The real check passes them.
  - An explosion's route still arrives in two calls; its second call is
    47,623 of 48,000 characters.

### After the second fireball run

The user called it "starting to look better":
- the fire is a boiling mass that breaks up, not a scaled image;
- the smoke is a grey, see-through cloud;
- no sheet held a shape (its smoke sheet moved a median 25-28% a frame);
- nothing was left behind.

**What still looked off:**
- **The last fire pieces read as paper cut-outs.** At 0.6 s they were large,
  hard-edged and one flat red-orange, measured at about `#e25b27` in the
  capture. That is close to what the FireBody example gives at the end of its
  life: its last Colour at Brightness 5 on the fire-burst sheet's plain body
  value comes to `#ff5424`. Rendered with the example's Colour at Brightness
  5, the sheet showed the cause: once its hot heart shrank, every later frame
  was one value, so one flat tone with a sharp edge. In the videos that
  moment is a charred core whose edges glow.
- **The playtest captures came late.** Asked for 0.6, 0.72, 0.8 and 1.3 s,
  `capture_moments` returned frames at 1.23, 1.42, 1.93 and 2.37 s. Each
  call's first moment was on time, then every later one was about a
  capture's length late (about 0.9 s in a playtest). The run held a clock of
  its own whose `setTimeScale(0)` did not stop it. The tool read the clock
  before each screenshot, never checked that holding worked, and still said
  each frame was "held still". So the in-game check never saw the fire at its
  peak.

**What changed:**
- **`vfx-explosions.md`:**
  - The fire-burst example's value now falls with time:
    1. white-hot;
    2. yellow, then orange;
    3. a centre that chars to about 0.05;
    4. edges that glow (0.35) in places and soften as it breaks up.
  - At Brightness 5 only a value under about 0.1 reads dark, which the guide
    now says.
  - Its check asks for a charred centre with red edges rather than one flat
    orange.
- **`runtime/capture-moments.ts`:**
  - After holding, the clock is read again two frames later. A clock that
    moved is reported: the result names the handle and the time each capture
    took, and says frames came out late.
  - A moment reached more than 0.05 s past its time says how late it is.
  - "Held still" is said only when the clock held.
  - A late frame is paired with the reference clip where the effect really
    was.
- **`vfx-craft.md` and the operation's description:** a handle's
  `setTimeScale(0)` must stop both its time and what it draws.
- **Checks:**
  - The example was run as printed with the helpers in numpy outside
    Blender. It still moves a median 30% a frame, and the real sheet check
    passes it.
  - An explosion's route still arrives in two calls. Its second call is
    47,956 of 48,000 characters, so the next addition to that route needs a
    matching cut.
- **Left for the next step:** effects a game plays by itself could still not
  be held. Their moments were reported late rather than mislabelled.

### Live capture

An effect the game plays by itself (a cast, a hit) runs on the game's own
clock, so holding it is not possible. The screenshot itself was never the
problem: `CaptureService:CaptureScreenshot` grabs a frame at once. What took
the second was reading the picture back and encoding it, between moments.

**Built:**
- **`capture_moments` with `live: true`:**
  1. One probe asks the client to take a screenshot, and Roqer reads it
     back. A client that cannot (an error, a window that is not rendering,
     or a capture the edit DM cannot read) is reported before the effect
     starts, so a cast is not spent for nothing.
  2. One call then runs the code that triggers the effect and waits for each
     time on the client.
  3. At each time it takes the screenshot there and then, from inside the
     game, and moves on.
  4. Afterwards Roqer reads each capture back.
- **Timing:**
  - Times are real seconds after the code returns, or a new handle's `time`
    when the code stores one. A handle whose clock stops has ended, and the
    rest is captured where it stopped.
  - Times reach 15 s, so every moment fits one bridge call.
  - Nothing is held, preloaded or stopped: the effect plays out as in the
    game.
- **Truthful results:** a moment more than 0.05 s late says so, and a
  screenshot slow to finish is named.
- **`capture_screenshot` takes `capture_id`:** the `rbxtemp://` id such a
  capture gave. It reads that capture in the edit DM, the second half of a
  play-mode capture, instead of taking one. Only temporary capture ids are
  accepted, with no `..`, so it cannot become a way to fetch other content
  with the edit DM's privileges. It is a read, and the inspector edition
  keeps it.
- **A side effect on multi-client playtests:** a live capture on
  `target: "client-2"` is client 2's view, because client 2 takes it. A held
  capture still screenshots client 1, since `capture_screenshot` takes no
  `target`.

**Checked:**
- The generated client Luau was run in Lua 5.1 against a simulated game with
  a frame clock, a `CaptureService` whose callback fires a few frames later
  (or never, or errors) and an emit-like handle:
  - moments land within a frame of their times;
  - a handle's clock is followed until its effect ends;
  - a slow screenshot makes the next moment late, and it is said so;
  - the probe catches both failures;
  - code that assigns globals named like Roqer's locals cannot disturb them,
    since it runs before they exist.
- Unit tests cover the arguments, the call sequence, the reads by
  `capture_id` and every failure the result names.

**Not checked in Studio at the time:**
- that a LocalScript may call `CaptureService:CaptureScreenshot`, which the
  plugin had so far called only from its own client context;
- that the edit DM reads those ids as it reads the plugin's;
- how soon after the call the frame is taken.

The probe turns the first two into a clear refusal before anything starts,
not into wrong frames. The next run answered both (below).

### After the third fireball run

The same brief, with live capture available. The agent used it five times
in a solo playtest.

**What it showed:**
- **Live capture works in Studio.** A LocalScript may call
  `CaptureScreenshot`, and the edit DM reads its ids. Each call's first
  moment came within a frame of its time: 0.15 → 0.165, 0.12 → 0.133,
  0.45 → 0.465 and 0.26 → 0.266 s.
- **A screenshot taken inside the game takes 0.33-0.38 s to finish.** The
  loop waits for one before the next, so one play gives at most a frame
  every third of a second. Asked for 0.15, 0.32, 0.45, 0.62, 0.75 and
  0.95 s, it captured at 0.165, 0.499, 0.831, 1.183, 1.515 and 1.849 s, each
  said to be late. Whether a second screenshot may be asked for before the
  first finishes, and whether its frame would then be taken at once, is not
  known.
- **The first two live captures showed no effect at all.** No particle was
  drawn, though the first cast did its damage and the second showed the
  throw pose. The textures had been uploaded just before the playtest, and
  live capture loaded nothing first. A held capture (whose preload waits for
  its textures) then showed the explosion, and every live capture after it
  did too. The agent put the first empty capture down to loading textures,
  and did not remark on the second.
- **A held capture in the playtest works** when the code plays the effect
  through the emit module on the client: 0.25 → 0.252 and 0.6 → 0.601 s.

**What changed:**
- **The live probe now loads textures first.** It loads the particles,
  beams, trails, decals and textures under `ReplicatedStorage`,
  `ReplicatedFirst` and the local player's scripts and backpack, for at
  most 10 s and 2,000 objects, before its test screenshot. The result says
  how many loaded, or that they were still loading.
- **Late moments get advice.** The result names the moments that came late
  and says to capture them in another call.
- **The guidance and the operation's description** say a frame takes about
  0.35 s to finish, so live times are spaced that far apart.

## Sixth study: why our effects read cheaper than artists'

A magic-missile brief asked for "deep violet and magenta with sharp white
highlights, not soft or bubbly". The user found the result cheap next to the
artists' work, "crisp and high quality", without being able to say why.

### Method

- The run's frames were measured against the eight artist videos in the
  dump, and against the fireball run's frames from the same bright test
  place.
- Every frame was scaled to 320 pixels wide. The effect is what differs from
  the frames' per-pixel median by more than 0.12. Measurement used the
  busiest third of the frames.
- Each effect pixel was sorted as one of:
  - pale: bright and nearly grey (max above 0.6, saturation under 0.35);
  - vivid: bright and saturated (above 0.5, saturation 0.5 or more);
  - deep: darker and saturated (0.5 or less, saturation 0.4 or more);
  - blown out: every channel above 0.9.
- The 5,010 studied emitters were then re-read for how brightness and
  blending divide between soft glows, sharp shapes and white layers.

### Findings

| | Pale | Vivid or deep | Blown out |
| --- | --- | --- | --- |
| The magic-missile run | 74-85% | 3-6% | 15-24% |
| Eight artist videos | 2-21% | 35-90% | 0-9% |
| The fireball run, same place | 8-17% | 17-25% | 0% |

- **The colour washed out.** Additive layers only lighten what is behind
  them, so over a bright sky violet goes pastel, then white.
  - The artist videos are shot in darker scenes (background value
    0.04-0.44, against 0.63-0.68 here). The fireball in the same place is
    the control: it stayed saturated.
  - 58% of the studied saturated layers are solid (`LightEmission` 0.3 or
    less, 11% of them negative). 35% are additive.
- **Soft glows are dim; sharp shapes carry the brightness.**
  - The 93 studied soft additive glows have a median Brightness of 1 and
    are about two-thirds transparent at their most solid.
  - The 508 crisp additive shapes have a median Brightness of 4 and are
    opaque.
  - White layers sit at Brightness 1 (median, 90% at 3 or less).
  - The artist's own Magic Missiles makes its white core a separate solid
    white layer (`LightEmission` 0, Brightness 1). Its soft glow is 86-96%
    transparent, its shapes are 0.7-3.7 studs, and its textures cover 1-13%
    of their canvas.
- **Not the cause:**
  - Fine detail: the run had as many small bright marks per frame as the
    videos.
  - The flash: the studied flashes reach a median of 15 studs at
    Brightness 10, which the recipe matches.
  - The places' bloom: mostly Threshold 2 and Intensity 1-2, as a new place
    has.
- **The textures read as clip art** (not measured): a perfect four-point
  star, perfect rings, a pentagram, and Latin letters as runes. The artist's
  set is a flash with bent arms, a shard tumbling across an 8x8 sheet, thin
  streaks and dots. The guidance already warns about this.

### What changed

- **`runtime/effect-tone.ts`:** measures the shares from a capture's frames,
  with the clip analysis's background and change threshold. `capture_moments`
  reports them after every capture of three or more frames, with advice when
  the effect is washed out (over 40% pale) or blown out (over 12%).
  - The host decodes each frame at 320 pixels (`captureToneFrame`).
  - Frames a moving camera changes everywhere are left out.
  - Run on the real frames, it flags the magic run (both warnings) and
    passes the fireball and the artist videos.
- **`vfx-design.md`:**
  - Colour in daylight is solid.
  - Soft glows are about two-thirds transparent; the sharp shapes carry the
    brightness.
  - The study list is shorter, to keep the core pair inside one call
    (47,780 of 48,000 characters).
- **`vfx-craft.md`:**
  - The bloom check no longer asks for every layer above the threshold: only
    sharp shapes go above it, and soft glows stay dim.
  - The capture step mentions the colour check, in fewer words.
- **Left:** a texture check for clip-art symmetry. Sigils and rings are
  rightly symmetric, so a plain symmetry test would flag them too.

## Seventh study: why it still looked lower quality

After the colour check the user still found the effects lower quality than
the artists', beyond colour. This study compared what the agent makes with
the studied files directly, property by property and pixel by pixel.

### Method

- The 1,427 dump textures were scaled to 256 pixels and measured from their
  pixels; 230 originals were fetched at full size from the asset service.
- A ring is a texture whose drawn pixels (alpha times value at least 0.15)
  lie mostly in one band about the centre, around at least half of it. For
  each of 72 angles round it: the brightest pixel and the band's width.
- Line textures were thinned to their centre line, and the brightness along
  it read.
- The 5,010 studied emitters were re-read for per-particle variation
  (`NumberSequence` envelopes) and the 48 files for meshes.
- Each was compared with the magic-missile run's textures and Roqer's own
  recipes.

### Findings

| | Studied artists | The run or the guidance |
| --- | --- | --- |
| Rings that vary round the circle | 84% of 159 | 0 of 2 |
| Ring brightness spread, width spread | median 32%, 51% | 1-7%, 18-22% |
| Share of a ring at full brightness | median 8% | 88-100% |
| Share of a stroke near full brightness | median 13% of 752 (40% faint) | 48-82% (spikes, ring, sigil) |
| Drawn pixels near full: soft, crisp, mixed | 1%, 19%, 29% of 1,393 | |
| Flipbooks and single images at 1024 px | 93% of 89, 42% of 122 | single images capped at 512 |
| Emitters with a Size envelope | 51% of 5,010, in 37 of 39 files | no recipe |
| Files with glowing meshes | 20 of 48 (29 with any mesh) | not on the missile route |

- **The guidance was wrong about rings.** It said soft shock rings are even,
  and symbols have even line weight; both came from a community kit, not
  the studied effects. The artists' rings are a bright, thick arc that thins
  and fades round the rest, brush strokes with breaks, or radial streaks,
  with the variation smooth rather than lumpy.
- **Value inside a texture.** Soft light is a small hot core; a stroke is
  bright at an accent and fades along the rest. The run's shapes were bright
  along their whole length.
- **Every particle of a layer was the same size.** Half the studied emitters
  draw each particle's size from a range a median third of the peak.
- **Resolution.** The size rule capped single textures at 512, under the
  1024 most artists upload for what is large or crisp.
- **Not the cause:**
  - Symmetry and taper: 44% of the artists' crisp single textures are
    strongly symmetric, so a symmetry measure does not tell theirs from ours.
  - Detail: the run's textures carry as much small detail.
  - Easing: the size and transparency curves ease alike; the median studied
    size curve has 3 keys.

### What changed

- **`runtime/texture-ring.ts`:** finds a ring from a texture's pixels and
  notes one that is even all round, with the studied numbers and what to
  change. The Blender worker attaches the note to each drawn image it
  reports.
  - Run over the 1,427 dump textures it finds the same 159 rings as the
    study's script and notes 16% of them.
  - It notes the run's ring and rune band; the sigil is not a ring.
- **`vfx-textures.md`:**
  - Rings are round, not even, with the measured numbers and a ring example
    (drawn with the real helpers: brightness spread 38%, width 55%).
  - A brightness bullet with the family numbers, and a value question in the
    review checklist; the symmetry question no longer exempts a ring's
    value and width.
  - Large or crisp textures at 1024, and the crisp examples drawn at 1024.
  - The section that repeated "What textures look like", and the two upload
    instructions, are merged, so the explosion route's second call shrank
    (47,775 of 48,000 characters, from 47,956).
- **`vfx-design.md`:** each particle its own size, with the `envelope`
  format; the glowing-mesh share. Two bullets are shorter to keep the core
  pair in one call (47,962).
- **`vfx-craft.md`:** the streaks example carries an envelope, and the
  recipe test checks that envelopes are numbers of 0 or more on
  `NumberSequence` keys only.
- **`SKILL.md`:** the mesh topic names the glowing-mesh share.
- **Left:**
  - No new run has been made to see whether the effects now look better.
  - Strokes are not checked from their pixels, only rings; a flipbook's
    cells are not checked for rings.

## The second magic-missile and fireball runs

The user found both "a bit better again". They are the first runs with the
colour check and the seventh study's guidance.

### What changed in the effects

- **Colour.** The magic run's colour check started at 64% pale, as the
  first run (74-85%) had been. The agent moved colour onto solid layers
  until its playtest frames measured 21% pale, 26% vivid and 7% deep (the
  studied range is 2-21% pale, 35-90% vivid or deep). A wide shot over open
  sky still measured 43% pale, and the agent told the user so.
- **Rings.** The shock ring is a bright arc that thins round the rest, as
  the new example draws. The sigil is still a pentagram of even lines.
- **The finale** dissolves its crescent dome into dark fragments, as the
  studied burn-outs do.

### What was still wrong

- **The fireball's smoke read as a pale blue cloud.** Measured on the
  playtest frame, the smoke over the sky was hue 201° at value 0.74, the sky
  199° at 0.85: half-transparent grey takes the sky's colour. The studied
  smoke's opacity (a median Transparency of 0.59 at its most solid) comes
  from darker scenes. The agent saw it and made the smoke a smaller, darker,
  warmer haze.
- **A line from the explosion to the thrower.** The fireball flies at 120
  studs a second and its ribbons copied the 0.6-0.85 s lifetimes measured
  on curving missiles, so they were 72-100 studs long. At impact the script
  only disabled them, so the whole straight path stayed drawn. Of 66
  studied trails, 57 taper to nothing and 27 fade to transparent; 64 do one
  or the other.
- **Two live captures showed nothing.** Five and six frames of the caster
  standing still, while the server recorded the hit. The colour check then
  said nothing at all, so the result looked like any capture it had no
  opinion on. The agent noticed and probed before capturing the fireball;
  the cause was not found from the export.

### What changed

- **`runtime/effect-tone.ts`:** when no frame can be measured, the colour
  check says why. Either nothing changes over 0.3% of the picture (not on
  screen, too small, or the same in every frame), or the frames differ
  almost everywhere, as a moving camera makes them. `capture_moments`
  reports it after the moments, with `tone.unmeasured` in its data.
- **`vfx-explosions.md`:** over a bright sky, smoke is more solid at its
  peak (Transparency 0.2-0.35), so it shows its own grey.
- **`vfx-motion.md`:** a trail is speed × lifetime long and still drawn at
  impact; on a fast, straight shot keep it a few times the head's length,
  fade its tail, or clear it at impact.
- Two passages in `vfx-textures.md` and the explosions introduction are
  shorter, to keep the explosion route's second call within 48,000
  characters (47,890).
- **Left:** the smoke opacity and trail length are starting points, not yet
  seen in Studio.

## Deferred, and why

- **Runtime EditableMesh/EditableImage effects** (UV scrolling on meshes,
  procedural trails): most players cannot see them without ID verification.
  Revisit if Roblox removes the gate
  ([request](https://devforum.roblox.com/t/remove-required-id-verification-for-editablemeshesimages/3981479)).
- **Fluid simulation flipbooks** (Blender Mantaflow smoke and fire): not yet
  tested against the 200 s job cap, even with `continue_from` chaining. Wait
  until the step 2 render budget is measured. Creator Store textures cover
  most smoke and fire needs meanwhile.
- **Vendoring a community emit module:** licences are unchecked, and the
  attribute convention is easy to implement. Write the in-repo module, and
  stay compatible with the convention.
- **AI-generated textures:** they give no originality assurance against
  moderation, and need a user key. Revisit after the Blender texture helpers.

## Open questions

1. **Answered 2026-10-02: yes, for particles, lights and Heartbeat.** An
   effect played from `execute_luau` animates in the edit viewport: 31
   Heartbeats in 0.5 s, and particles, a `PointLight` and mesh motion all
   rendered. Step 3 does not need a playtest. Beam `TextureSpeed` and
   `TweenService` were not probed.
2. **Answered 2026-10-02:** a capture took 843-894 ms in edit mode and
   661-812 ms in a playtest client, consistently. That is too slow to catch a
   burst at any speed. Pausing the module's clock (`setTimeScale(0)`) at each
   moment, capturing, then resuming held every frame within 2 ms of the
   requested effect time. That is the step 3 mechanism, and it already works
   with existing tools.
3. What are the image and mesh upload quotas for Open Cloud on an unverified
   account?
4. Have Custom flipbook layouts left Client Beta, and what is
   `FlipbookBlendFrames`' current default? (The `@rbxts/types` 1.0.906 typings
   do not list `FlipbookBlendFrames`.)
   - Related, observed 2026-10-02: Studio's `FlipbookIncompatible` reads
     "Particle texture must be 1024 by 1024 to use flipbooks." for every
     texture tried, including an uploaded 1024² sheet that plays (see step
     2). It says nothing about a sheet.
   - 1024² is verified to play. Whether smaller square power-of-two sheets
     still play, as the 2022 release allowed, is untested.
5. Does vertex alpha from an FBX import reach the renderer on a MeshPart? The
   staff post covers only RGB. If it does, mesh fades need no texture.
