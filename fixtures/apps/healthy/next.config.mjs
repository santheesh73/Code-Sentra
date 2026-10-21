/** Static export so the fixture harness can serve it without a Node runtime. */
const config = {
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default config;
