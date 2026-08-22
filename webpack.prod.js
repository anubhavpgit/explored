const path = require("path");

module.exports = {
  mode: "production",
  entry: ["./src/index.js"],
  devtool: "source-map",
  plugins: [],
  module: {
    rules: [
      {
        test: /\.(png|jpe?g|jpg)$/i,
        loader: "file-loader",
        options: {
          name: "[path][name].[ext]",
          outputPath: "./assets",
        },
      },
    ],
  },
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
    // publicPath is left at the default "auto", which resolves runtime asset
    // URLs relative to the loaded script. That keeps the bundle working when
    // the site is served from the /explored/ subpath on GitHub Pages.
  },
};
