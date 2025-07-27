const path = require("path");
const webpack = require("webpack");

module.exports = {
  mode: "development",
  entry: ["./src/index.js"],
  devtool: "inline-source-map",
  devServer: {
    static: {
      directory: path.join(__dirname),
    },
    open: false,
    hot: true,
    liveReload: true,
    watchFiles: ['src/**/*', 'index.html'],
    port: 8080,
    client: {
      overlay: true,
      progress: true,
    },
  },
  plugins: [
    new webpack.HotModuleReplacementPlugin(),
  ],
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
    publicPath: "/",
  },
};
