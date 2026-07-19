//go:build !windows

package main

import _ "embed"

//go:embed icon.png
var iconPNG []byte

func iconBytes() []byte { return iconPNG }
