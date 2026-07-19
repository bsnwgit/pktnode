//go:build windows

package main

import _ "embed"

//go:embed icon.ico
var iconICO []byte

func iconBytes() []byte { return iconICO }
