#!/usr/bin/env python3
"""Check the deployed gateway with two real, billable Chat Completions calls."""
import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request


def request(base, path, key=None, payload=None):
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    return urllib.request.urlopen(
        urllib.request.Request(base + path, data=data, headers=headers), timeout=180
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--model", default="llm-auto")
    parser.add_argument("--tools", action="store_true", help="Also make a billable tool-call request")
    args = parser.parse_args()
    base = args.url.rstrip("/").removesuffix("/v1")
    with request(base, "/api/status") as response:
        status = json.load(response)
    if status.get("success") is not True:
        raise ValueError("Gateway health check did not succeed")
    print("PASS gateway health")

    key = os.getenv("GATEWAY_API_KEY") or getpass.getpass("Gateway API key: ").strip()
    if not key:
        raise ValueError("A customer API key is required")
    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": "Reply briefly with hello."}],
        "max_tokens": 64,
    }
    with request(base, "/v1/chat/completions", key, payload) as response:
        result = json.load(response)
    if not result.get("choices") or "message" not in result["choices"][0]:
        raise ValueError("Non-stream response has no assistant message")
    print("PASS chat completions; response model:", result.get("model", "(not provided)"))
    print("Usage:", json.dumps(result.get("usage"), ensure_ascii=False))

    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    chunks = 0
    done = False
    with request(base, "/v1/chat/completions", key, payload) as response:
        if "text/event-stream" not in response.headers.get("Content-Type", ""):
            raise ValueError("Streaming response is not text/event-stream")
        for line in response:
            line = line.decode().strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                done = True
                break
            chunk = json.loads(data)
            if "error" in chunk:
                raise ValueError("Streaming response returned an error")
            if chunk.get("choices"):
                chunks += 1
    if not done or not chunks:
        raise ValueError("Incomplete stream: expected response chunks and [DONE]")
    print("PASS SSE stream completed")

    if args.tools:
        payload.pop("stream_options", None)
        payload["stream"] = False
        payload["messages"] = [{"role": "user", "content": "Call gateway_ping with value hello."}]
        payload["tools"] = [{
            "type": "function",
            "function": {
                "name": "gateway_ping",
                "description": "Return a test value",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                },
            },
        }]
        payload["tool_choice"] = {"type": "function", "function": {"name": "gateway_ping"}}
        with request(base, "/v1/chat/completions", key, payload) as response:
            result = json.load(response)
        calls = result.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])
        if not calls or calls[0].get("function", {}).get("name") != "gateway_ping":
            raise ValueError("No expected tool call; confirm the selected model supports tools")
        print("PASS tool call")
    print("Check the consumption log for the selected actual model and corresponding price.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f"FAIL HTTP {error.code}; inspect the gateway log for details", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
