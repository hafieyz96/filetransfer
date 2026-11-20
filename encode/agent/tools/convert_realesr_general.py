"""
Convert the official Real-ESRGAN `realesr-general-x4v3` weights (PyTorch .pth, xinntao/Real-ESRGAN
release v0.2.5.0) to ncnn so Video2X (Vulkan, FP16) can run them.

Why: realesrgan-plus (RRDBNet x4plus) runs at ~0.26 fps on an RTX 2060 at 540x960 input, far too
slow for 30-120 fps video. realesr-general-x4v3 is the authors' compact model for real-world
footage (SRVGGNetCompact, ~1.2M params) and supports a denoise-strength blend with the
`-wdn-` weights, exactly like inference_realesrgan.py's --denoise_strength (dni).

Usage (one-off, CPU is enough):
    python convert_realesr_general.py <dir with both .pth files> <out dir> [strength ...]
Strength follows Real-ESRGAN: 1.0 = general-x4v3 (keeps grain/detail), 0.0 = wdn (strongest denoise).

Outputs  realesr-general-x4v3-dn<NN>.param/.bin  with ncnn blob names `data` -> `output`,
matching the realesrgan-ncnn-vulkan / Video2X convention.
"""
import os
import re
import sys
import shutil
import tempfile

import torch
import torch.nn as nn
import torch.nn.functional as F


class SRVGGNetCompact(nn.Module):
    """Same layer layout as realesrgan/archs/srvgg_arch.py (BSD-3-Clause), prelu variant."""

    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        return out + F.interpolate(x, scale_factor=self.upscale, mode='nearest')


def load(path):
    sd = torch.load(path, map_location='cpu', weights_only=True)
    return sd.get('params_ema', sd.get('params', sd))


def main():
    src, out = sys.argv[1], sys.argv[2]
    strengths = [float(s) for s in sys.argv[3:]] or [1.0, 0.5]
    general = load(os.path.join(src, 'realesr-general-x4v3.pth'))
    wdn = load(os.path.join(src, 'realesr-general-wdn-x4v3.pth'))
    os.makedirs(out, exist_ok=True)
    import pnnx

    for s in strengths:
        net = SRVGGNetCompact().eval()
        net.load_state_dict({k: s * general[k] + (1 - s) * wdn[k] for k in general}, strict=True)
        name = f'realesr-general-x4v3-dn{int(round(s * 100)):02d}'
        # forward slashes: pnnx writes this path into generated Python source unescaped
        work = tempfile.mkdtemp(prefix='cvt-').replace('\\', '/')
        try:
            x = torch.rand(1, 3, 64, 64)
            pt = os.path.join(work, 'model.pt')
            torch.jit.trace(net, x).save(pt)
            pnnx.convert(pt, [x], inputs2=[torch.rand(1, 3, 96, 80)], device='cpu')  # 2 shapes -> dynamic
            param = open(os.path.join(work, 'model.ncnn.param'), encoding='utf8').read()
            # rename pnnx's in0/out0 to the realesrgan-ncnn names (whole-word only)
            param = re.sub(r'(?<=\s)in0(?=\s|$)', 'data', param, flags=re.M)
            param = re.sub(r'(?<=\s)out0(?=\s|$)', 'output', param, flags=re.M)
            open(os.path.join(out, name + '.param'), 'w', encoding='utf8', newline='\n').write(param)
            shutil.copyfile(os.path.join(work, 'model.ncnn.bin'), os.path.join(out, name + '.bin'))
            print('wrote', name)
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
