# 🎬 Flash to Godot — Export Pipeline

A suite of optimized **JSFL scripts** for **Adobe Animate / Flash Professional** that natively exports animations, symbols, and vector shapes directly to **Godot Engine 4** (`.tscn` files).

---

## 🚀 Features

* **Native Vector Extraction (`Polygon2D`)**: Automatically converts Flash shapes and gradients into native Godot `Polygon2D` nodes. Supports complex geometry with hole management (via bridges), T-junction repair, and utilizes adaptive Casteljau subdivision for perfectly smooth Bezier curves.
* **Animation Baking**: Converts Flash interpolations (Tweens) and keyframes directly into native tracks for Godot's `AnimationPlayer` (handles `position`, `rotation`, `scale`, `visible`, and `color`). Also manages timeline slicing via Flash labels.
* **Masks & Shaders**: Faithfully reproduces Flash clipping masks (`clip_children`), *ColorTransform* effects (color offsets), and blend modes (`add`, `multiply`) through the automatic generation of dedicated `.gdshader` files.
* **Group Safety**: Non-destructive process that temporarily converts static groups into symbols to preserve their absolute transformation matrices.

---
 
## 📁 Script Project Structure

For the pipeline to work correctly, you must keep the following folder structure:

```text
📂 flash-to-godot/
│
├── 📄 main.jsfl                  # Main script (UI entry point)
│
└── 📂 modules/
    ├── 📄 inspector.jsfl      # FLA metadata analyzer and extractor
    └── 📄 godotBuilder.jsfl   # .tscn scenes, shaders, and animations compiler
```

---

## ⚙️ Configuration & Installation

### Prerequisites
- Adobe Animate (or Flash Pro with JSFL API support).
- Godot Engine 4.x (generated files target Godot 4's standard scene format 3).

### Pipeline Usage
1. Open your animation or `.fla` document in Adobe Animate.
2. Go to the top menu: **Commands > Run Command...**
3. Select the `main.jsfl` file at the root of this folder.
4. A file explorer window will open: **select the root folder of your Godot project** (the folder containing the `project.godot` file).
5. The script automatically calculates relative paths, creates the necessary folder tree, and processes the elements. You can monitor the real-time progress in the **Output** panel of Adobe Animate.

---

## 📂 Exported File Structure in Godot

Once the pipeline has finished, the following files will be generated inside your Godot project:

```text
📂 YourGodotProject/
│
├── 📄 main.tscn                  # Reconstructed main scene (active Flash scene)
│
├── 📂 shaders/                   # CanvasItem shaders to reproduce Flash effects
│   ├── 🧪 flash_color_normal.gdshader   # ColorTransform support (Offsets)
│   ├── 🧪 flash_color_add.gdshader      # "Add" / "Screen" blend mode
│   └── 🧪 flash_color_mul.gdshader      # "Multiply" blend mode
│
└── 📂 symbols/                   # Godot sub-scenes (.tscn) generated for MovieClips
    ├── 📄 MyNestedSymbol.tscn
    └── ...
```
*(Files named `debug_data.json` and `debug_log.txt` will also be generated at the root to assist in troubleshooting).*

---

## ⚠️ Notes
* **Scripts (AS3/JS)**: Code is ignored; only visual properties and animations are exported.
* **Massive Vector Files**: Very complex shapes or those with an enormous amount of details may temporarily freeze Animate's UI during the export.
* **Guide Layers**: Guide Layers are respected and exported as hidden nodes (`visible = false`).
