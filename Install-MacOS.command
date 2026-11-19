
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_DIR="$SCRIPT_DIR/OmniDL-Core/tools"

if ! command -v brew >/dev/null 2>&1; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew installation failed."
    exit 1
fi

brew update

for package in yt-dlp ffmpeg jq; do
    if brew list --formula "$package" >/dev/null 2>&1; then
        if brew outdated --formula "$package" | grep -Fxq "$package"; then
            brew upgrade "$package"
        fi
    else
        brew install "$package"
    fi
done

case "$(uname -m)" in
    arm64)
        ARCH="osx-arm64"
        ;;
    x86_64)
        ARCH="osx-x64"
        ;;
    *)
        echo "Unsupported macOS architecture."
        exit 1
        ;;
esac

mkdir -p "$TOOLS_DIR"

RELEASE_JSON="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: OmniDL-Installer" \
    https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest)"

VERSION="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name')"

DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | jq -r \
    --arg arch "$ARCH" \
    '.assets[] | select(.name | endswith($arch + ".tar.gz") or test("_" + $arch + "_.*\\.tar\\.gz$")) | .browser_download_url' \
    | head -n 1)"

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
    echo "N_m3u8DL-RE download URL not found."
    exit 1
fi

VERSION_FILE="$TOOLS_DIR/.n_m3u8dl-re-version-macos"
EXECUTABLE="$TOOLS_DIR/N_m3u8DL-RE"
EXPECTED_VERSION="$VERSION/$ARCH"

if [ -f "$EXECUTABLE" ] &&
   [ -f "$VERSION_FILE" ] &&
   [ "$(cat "$VERSION_FILE")" = "$EXPECTED_VERSION" ]; then
    echo "N_m3u8DL-RE is up to date."
else
    TEMP_DIR="$(mktemp -d)"

    trap 'rm -rf "$TEMP_DIR"' EXIT

    curl -fL "$DOWNLOAD_URL" -o "$TEMP_DIR/package.tar.gz"

    mkdir -p "$TEMP_DIR/extracted"
    tar -xzf "$TEMP_DIR/package.tar.gz" -C "$TEMP_DIR/extracted"

    SOURCE="$(find "$TEMP_DIR/extracted" -type f -name "N_m3u8DL-RE" -print -quit)"

    if [ -z "$SOURCE" ]; then
        echo "N_m3u8DL-RE executable not found."
        exit 1
    fi

    install -m 755 "$SOURCE" "$EXECUTABLE"

    printf '%s\n' "$EXPECTED_VERSION" > "$VERSION_FILE"

    echo "N_m3u8DL-RE installed: $EXPECTED_VERSION"
fi

echo "Installation completed."
