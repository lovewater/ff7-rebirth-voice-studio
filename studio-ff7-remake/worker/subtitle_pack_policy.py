"""Published-tree compatibility entry for the shared subtitle packaging policy."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_source = Path(__file__).resolve().parents[2] / 'studio-common/worker/subtitle_pack_policy.py'
_spec = spec_from_file_location('_ff7_shared_subtitle_pack_policy', _source)
_shared = module_from_spec(_spec)
_spec.loader.exec_module(_shared)
POLICY = _shared.POLICY
POLICY_SOURCE = _shared.POLICY_SOURCE
has_original_chinese_subtitle = _shared.has_original_chinese_subtitle
