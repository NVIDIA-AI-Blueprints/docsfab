---
title: "Installation Guide for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

<!-- @tpl:naming
Keep this cross-reference label and give every get-started page a `gs-` prefixed slug so {ref} links resolve across the Book. Do not strip this line when copying the template.
-->

(gs-installation)=
# Installation Guide for [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Installation Guide for" followed by the [Product Name], such as Installation Guide for NeMo Microservices Helm Chart. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Installation template. Use it for a comprehensive installation guide that covers multiple installation methods, package options, verification steps, and troubleshooting. -->

<!-- @tpl:example
To get started, refer to [Installation Guide for NeMo Curator](https://docs.nvidia.com/nemo/curator/latest/get-started/installation).
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory sentence or paragraph that explains what the Installation Guide will help users accomplish. Replace the following example with your own text.
-->
There are three installation paths: PyPI for quick evaluation, source checkout for development, and container for reproducible production runs.

## Prerequisites
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
If applicable, provide and format the essential prerequisites as an ordered list. This should be a short list of prerequisites. Cross-reference the Prerequisites page. Replace the following example with your own text.
-->

Before you start, you must complete the following prerequisites:

1. Start each step with an active verb.
2. Try to avoid “Ensure that”.

<!-- @tpl:example
1. Install a supported operating system.
2. Install the required Python version.
3. Verify your machine's RAM specifications against the minimum RAM requirements.
4. (Optional) Install GPU drivers for accelerated workflows.

For comprehensive system prerequisites and verified configurations, refer to [Prerequisites](/path/to/prerequisites.md).
-->

## Installation Methods
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide multiple installation methods using in-page tabs (`tab-set`) for easy comparison. PyPI installation is recommended for most users. Source installation is best for contributors. Container installation provides a pre-configured environment for production.
-->

<!-- @tpl:example
- **Package**: `uv pip install "nemo-curator[text_cpu]"` for a supported released package.
- **Source**: `uv pip install -e .` when contributing or testing unreleased changes.
- **Container**: Pull the published image when the runtime must be reproducible across machines.
-->

Choose the installation method that best fits your environment and use case.

:::::{tab-set}

::::{tab-item} Package Installation (Recommended)

<!-- @tpl:formatting
Replace the following example with your product's package manager and registry (for example: pip, conda, npm, and cargo).
-->

Complete the following steps to install [Product Name] using the simplest method:

1. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

2. Install [Product Name]:

   ```bash
   pip install [package-name]
   ```

:::{note}
For specific features or GPU support, refer to [Package Extras](#package-extras).
:::

::::

::::{tab-item} Source Installation

Complete the following steps to install the latest development version directly from the repository:

```bash
# Clone the repository
git clone https://github.com/[org]/[repo].git
cd [repo]

# Create a virtual environment and install
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

::::

::::{tab-item} Container Installation

[Product Name] is available as a pre-configured container:

```bash
# Pull the container
docker pull [registry]/[image]:[tag]

# Run the container
docker run --gpus all -it --rm [registry]/[image]:[tag]
```

:::{seealso}
For container configuration options, refer to [Container Environments](link-to-container-docs).
:::

::::

:::::

## Package Extras
<!-- @tpl:naming
Do not rename this section.
 -->

[Product Name] offers optional package extras for installing the modules you need:

```{list-table} Available Package Extras
:header-rows: 1
:widths: 20 35 45

* - Extra
  - Installation Command
  - Description
* - **Base**
  - `pip install [package]`
  - CPU-only basic modules
* - **[Feature 1]**
  - `pip install [package][[feature1]]`
  - [Description of what this extra includes]
* - **[Feature 2]**
  - `pip install [package][[feature2]]`
  - [Description of what this extra includes]
* - **GPU**
  - `pip install [package][[gpu]]`
  - GPU-accelerated modules
* - **All**
  - `pip install [package][[all]]`
  - All modules (recommended for full functionality)
```

## Additional Setup
<!-- @tpl:naming
Do not rename this section.
 -->

<!-- @tpl:optional
Delete this entire section when the product does not need post-install credentials, model downloads, or environment variables.
-->

Some features require additional configuration after installation.

### Example: [Feature Name] Setup
<!-- @tpl:formatting
Describe the additional setup required, such as API key configurations and model downloads. Replace the following example with your own text.
-->

To use the Nemotron quality classifier, obtain an NGC API key from build.nvidia.com and set it as an environment variable or config file entry.

::::{tab-set}

:::{tab-item} Method 1: Environment variable

```bash
# Set API key
export API_KEY="your-key-here"
echo 'export API_KEY="your-key-here"' >> ~/.bashrc
```

:::

:::{tab-item} Method 2: Config file

```bash
mkdir -p ~/.config/[product]
echo 'api_key: your-key-here' > ~/.config/[product]/config.yaml
```

:::

::::

## Installation Verification
<!-- @tpl:naming
Do not rename this section.
 -->

<!-- @tpl:formatting
Provide the steps here users should complete to verify that the installation completed successfully. Provide an introductory sentence to introduce the steps. Replace the following example with your own text.
-->

<!-- @tpl:example
```bash
python -c "import nemo_curator; print(nemo_curator.__version__)"
```

Expected result: the installed version prints and the command exits with status 0.
-->

Verify that the installation completed successfully and core modules are accessible.

1. Test basic imports.

   ```python
   # Test basic imports
   import [package]
   print(f"[Product Name] version: {[package].__version__}")

   # Test core modules
   from [package] import [CoreModule]
   print("✅ Core modules imported successfully")
   ```

2. Check GPU availability.

   ```python
   # Check GPU availability (if applicable)
   try:
       import torch
       if torch.cuda.is_available():
           print(f"✅ GPU available: {torch.cuda.get_device_name(0)}")
       else:
           print("⚠ No GPU detected (CPU mode will be used)")
   except ImportError:
       print("⚠ GPU modules not installed")
   ```

3. Conduct a quick test.

   ```bash
   # Run the built-in verification
   [package-command] --version

   # Or run a simple example
   python -c "from [package] import [Module]; print('✅ Installation verified')"
   ```

**✅ Success Check**: You should see the version number and no import errors.

## Troubleshoot the Installation
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use this section to document common installation issues and solutions. If your Book has a general Troubleshooting section with an Installation subsection, link to it here instead.
-->

If you encounter issues during installation, check these common solutions.

<!-- @tpl:naming
-->

:::{dropdown} Command not found: [package-command]
Make sure you activated the virtual environment:

```bash
source .venv/bin/activate
```

Or check that the package installed correctly:

```bash
pip show [package-name]
```
:::

:::{dropdown} Import error: No module named '[package]'
The package may not be installed in your current environment. Verify the installation:

```bash
# Check if package is installed
pip list | grep [package]

# Reinstall if needed
pip install [package-name]
```
:::

:::{dropdown} GPU not detected
Check that CUDA drivers are installed and GPU is accessible:

```bash
# Verify NVIDIA driver
nvidia-smi

# Check CUDA version
nvcc --version
```

If GPU is not needed, use the CPU-only installation:

```bash
pip install [package-name]  # Without GPU extras
```
:::

:::{dropdown} Permission denied errors
Try installing in a virtual environment to avoid system-level permission issues:

```bash
python -m venv .venv
source .venv/bin/activate
pip install [package-name]
```
:::

:::{dropdown} Dependency conflicts
Use a fresh virtual environment to avoid conflicts:

```bash
# Create a clean environment
python -m venv .venv --clear
source .venv/bin/activate

# Install with fresh dependencies
pip install [package-name]
```
:::

## Next Steps
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use in-page cards to help navigate users to other related resources such as core concepts, user guides, and tutorials. Replace the following example with your own example. Do not include links to pages that have not been created yet. Provide an introductory sentence that summarizes the main next steps. Replace the following example with your own text.
-->

Now that [Product Name] is installed, you should explore the following resources in greater detail:

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Beginner Tutorial
:link: beginner-tutorial.md
:link-type: doc

Learn the fundamentals through a guided hands-on tutorial.
+++
{bdg-secondary}`tutorial`
:::

:::{grid-item-card} {octicon}`book;1.5em;sd-mr-1` Tutorials
:link: /tutorials/index.md
:link-type: doc

Explore in-depth tutorials for specific use cases and workflows.
+++
{bdg-secondary}`Hands-on guides`
:::

::::

<!-- @tpl:formatting
Add more in-page cards here as needed.
-->
