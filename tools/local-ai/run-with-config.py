#!/usr/bin/env python3
"""Load a private YAML file and launch the Overleaf web service with AI config.

Usage: run-with-config.py /path/to/ai-config.yaml command [args...]
Requires PyYAML in the runtime that starts the web service.
"""
import os
import stat
import sys
from pathlib import Path
import yaml


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Usage: run-with-config.py CONFIG COMMAND [ARGS...]')
    config_path = Path(sys.argv[1])
    if not config_path.is_file() or config_path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit('AI config must be a private regular file (mode 0600)')
    with config_path.open(encoding='utf-8') as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict) or not isinstance(config.get('openai'), dict):
        raise SystemExit('AI config must contain an openai mapping')
    settings = config['openai']
    key, model = settings.get('api_key'), settings.get('model')
    if not isinstance(key, str) or not key.strip() or not isinstance(model, str) or not model.strip():
        raise SystemExit('Set openai.api_key and openai.model in AI config')
    env = os.environ.copy()
    env['OPENAI_API_KEY'] = key.strip()
    env['OVERLEAF_AI_MODEL'] = model.strip()
    effort = settings.get('reasoning_effort', 'medium')
    if effort not in ('none', 'low', 'medium', 'high', 'xhigh', 'max'):
        raise SystemExit('Invalid openai.reasoning_effort')
    env['OVERLEAF_AI_REASONING_EFFORT'] = effort
    os.execvpe(sys.argv[2], sys.argv[2:], env)


if __name__ == '__main__':
    main()
