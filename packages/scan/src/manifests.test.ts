import { describe, expect, it } from "vitest";
import {
  parseCargoToml,
  parseComposerJson,
  parseGemfile,
  parseGoMod,
  parseGradle,
  parsePom,
} from "./manifests.js";

describe("manifests read as text", () => {
  it("go.mod: module, go version and requires (block and single line)", () => {
    const m = parseGoMod(
      "go.mod",
      [
        "module example.com/shop",
        "",
        "go 1.23",
        "",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.10.0",
        "\tgolang.org/x/text v0.14.0 // indirect",
        ")",
        "require github.com/google/uuid v1.6.0",
      ].join("\n"),
    );
    expect(m).toMatchObject({ name: "example.com/shop", version: "1.23", packageManager: "go" });
    expect(m.dependencies).toEqual({
      "github.com/gin-gonic/gin": "v1.10.0",
      "golang.org/x/text": "v0.14.0",
      "github.com/google/uuid": "v1.6.0",
    });
  });

  it("Gemfile: gem lines, with and without a version", () => {
    const m = parseGemfile(
      "Gemfile",
      'source "https://rubygems.org"\ngem "sinatra", "~> 4.0"\ngem \'rack-test\'\n# gem "old"\n',
    );
    expect(m.dependencies).toEqual({ sinatra: "~> 4.0", "rack-test": "*" });
  });

  it("pom.xml: own coordinates, not the parent's; dependencies", () => {
    const m = parsePom(
      "pom.xml",
      `<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent>
  <groupId>com.example</groupId>
  <artifactId>shop</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <!-- <dependency><groupId>x</groupId><artifactId>gone</artifactId></dependency> -->
    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.17.2</version></dependency>
  </dependencies>
</project>`,
    );
    expect(m).toMatchObject({ name: "com.example:shop", version: "1.0.0" });
    expect(m.dependencies).toEqual({
      "org.springframework.boot:spring-boot-starter-web": "*",
      "com.fasterxml.jackson.core:jackson-databind": "2.17.2",
    });
  });

  it("build.gradle: string-notation dependencies", () => {
    const m = parseGradle(
      "build.gradle",
      "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n  testImplementation(\"org.junit.jupiter:junit-jupiter:5.11.0\")\n}\n",
    );
    expect(m.dependencies).toEqual({
      "org.springframework.boot:spring-boot-starter-web": "*",
      "org.junit.jupiter:junit-jupiter": "5.11.0",
    });
  });

  it("Cargo.toml: package, inline and table dependencies", () => {
    const m = parseCargoToml(
      "Cargo.toml",
      [
        "[package]",
        'name = "notes-api"',
        'version = "0.1.0"',
        'description = "Notes over HTTP" # a comment',
        "",
        "[dependencies]",
        'axum = "0.7.5"',
        'serde = { version = "1.0", features = ["derive"] }',
        'local = { path = "../local" }',
        "",
        "[dev-dependencies.tokio]",
        'version = "1.40"',
        'features = ["full"]',
      ].join("\n"),
    );
    expect(m).toMatchObject({
      name: "notes-api",
      version: "0.1.0",
      description: "Notes over HTTP",
    });
    expect(m.dependencies).toEqual({ axum: "0.7.5", serde: "1.0", local: "*", tokio: "1.40" });
  });

  it("composer.json: require and require-dev, without platform packages", () => {
    const m = parseComposerJson(
      "composer.json",
      JSON.stringify({
        name: "acme/notes",
        description: "Notes",
        require: { php: "^8.2", "ext-json": "*", "slim/slim": "^4.12" },
        "require-dev": { "phpunit/phpunit": "^11.0" },
      }),
    );
    expect(m).toMatchObject({ name: "acme/notes", packageManager: "composer" });
    expect(m?.dependencies).toEqual({ "slim/slim": "^4.12", "phpunit/phpunit": "^11.0" });
    expect(parseComposerJson("composer.json", "{not json")).toBeNull();
  });
});
