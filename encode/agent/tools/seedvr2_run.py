"""Run SeedVR2's inference_cli.py, forcing fp16 compute on GPUs that only emulate bfloat16.

SeedVR2 (github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) picks bfloat16 when a bf16 matmul
*works*. Turing cards (RTX 20xx, compute 7.5) pass that probe through emulation, which made a
2 s clip take >17 min and run out of memory on an RTX 2060. fp16 runs the same clip in ~2 min.
This wrapper flips the choice before the pipeline modules import it, so the upstream checkout
stays unmodified.

usage: python seedvr2_run.py <seedvr2_repo_dir> [inference_cli.py args...]
env:   SEEDVR2_FORCE_FP16 = auto (default: fp16 below compute 8.0) | 1 (always) | 0 (never)
"""
import os
import runpy
import sys

repo = os.path.abspath(sys.argv[1])
cli = os.path.join(repo, "inference_cli.py")
sys.argv = [cli] + sys.argv[2:]
os.chdir(repo)
sys.path.insert(0, repo)

import torch  # noqa: E402

mode = os.environ.get("SEEDVR2_FORCE_FP16", "auto")
native_bf16 = torch.cuda.is_available() and torch.cuda.get_device_capability(0) >= (8, 0)
if mode == "1" or (mode == "auto" and torch.cuda.is_available() and not native_bf16):
    import src.optimization.compatibility as compat  # noqa: E402

    compat.BFLOAT16_SUPPORTED = False
    compat.COMPUTE_DTYPE = torch.float16
    print("[seedvr2_run] compute dtype forced to float16 (no native bfloat16 on this GPU)", flush=True)

runpy.run_path(cli, run_name="__main__")
