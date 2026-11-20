"""Run SeedVR2's inference_cli.py, forcing fp16 compute on GPUs that only emulate bfloat16.

SeedVR2 (github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) picks bfloat16 when a bf16 matmul
*works*. Turing cards (RTX 20xx, compute 7.5) pass that probe through emulation, which made a
2 s clip take >17 min and run out of memory on an RTX 2060. fp16 runs the same clip in ~2 min.
This wrapper flips the choice before the pipeline modules import it, so the upstream checkout
stays unmodified.

It also caps PyTorch's share of VRAM. On Windows the driver silently spills allocations that
do not fit into shared system memory (over PCIe) instead of failing, so PyTorch never empties
its cache: on a 6GB card the VAE decode of the 2nd chunk spilled ~2.3GB and took 8 min instead
of 36 s. With a cap, PyTorch frees its cached blocks and retries before the driver spills.

usage: python seedvr2_run.py <seedvr2_repo_dir> [inference_cli.py args...]
env:   SEEDVR2_FORCE_FP16 = auto (default: fp16 below compute 8.0) | 1 (always) | 0 (never)
       SEEDVR2_VRAM_HEADROOM_MB = VRAM left outside PyTorch's cap (default 300; 0 = no cap).
       700 left too little for the VAE encode (OOM) with 5.1GB free on the 2060.
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

headroom = int(os.environ.get("SEEDVR2_VRAM_HEADROOM_MB", "300"))
if headroom > 0 and torch.cuda.is_available():
    free, total = torch.cuda.mem_get_info(0)
    cap = free - headroom * 1024 * 1024
    if cap > 2 * 1024**3:
        torch.cuda.set_per_process_memory_fraction(cap / total, 0)
        print(f"[seedvr2_run] PyTorch VRAM cap {cap // 2**20} MB (free {free // 2**20} of {total // 2**20} MB)", flush=True)

runpy.run_path(cli, run_name="__main__")
