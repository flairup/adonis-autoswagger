import YAML from "json-to-pretty-yaml";
import fs from "fs";
import path from "path";
import util from "util";
import extract from "extract-comments";
import HTTPStatusCode from "http-status-code";
import { camelCase, isEmpty, isUndefined, snakeCase, startCase } from "lodash";
import { existsSync } from "fs";

/**
 * Autoswagger interfaces
 */
interface options {
  title: string;
  ignore: string[];
  version: string;
  path: string;
  tagIndex: number;
  snakeCase: boolean;
  common: common;
  preferredPutPatch?: string;
  persistAuthorization?: boolean;
}

interface common {
  headers: any;
  parameters: any;
}

/**
 * Adonis routes
 */
interface AdonisRouteMeta {
  resolvedHandler: {
    type: string;
    namespace?: string;
    method?: string;
  };
  resolvedMiddleware: Array<{
    type: string;
    args?: any[];
  }>;
}

interface v6Handler {
  method?: string;
  moduleNameOrPath?: string;
  reference: string | any[];
  name: string;
}

interface AdonisRoute {
  methods: string[];
  pattern: string;
  meta: AdonisRouteMeta;
  middleware: string[] | any;
  name?: string;
  params: string[];
  handler?: string | v6Handler;
}

interface AdonisRoutes {
  root: AdonisRoute[];
}

/**
 * Helpers
 */

function formatOperationId(inputString: string): string {
  // Remove non-alphanumeric characters and split the string into words
  const cleanedWords = inputString.replace(/[^a-zA-Z0-9]/g, " ").split(" ");

  // Pascal casing words
  const pascalCasedWords = cleanedWords.map((word) =>
    startCase(camelCase(word))
  );

  // Generate operationId by joining every parts
  const operationId = pascalCasedWords.join();

  // CamelCase the operationId
  return camelCase(operationId);
}

/**
 * Check if a string is a valid JSON
 */
function isJSONString(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch (error) {
    return false;
  }
}

export class AutoSwagger {
  private parsedFiles: string[] = [];
  private options: options;
  private schemas = {};

  private standardTypes = [
    "string",
    "number",
    "integer",
    "datetime",
    "boolean",
    "any",
  ]
    .map((type) => [type, type + "[]"])
    .flat();

  ui(url: string, options?: options) {
    const persistAuthString = options?.persistAuthorization
      ? "persistAuthorization: true,"
      : "";
    return `<!DOCTYPE html>
		<html lang="en">
		<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="X-UA-Compatible" content="ie=edge">
				<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui-standalone-preset.js"></script>
				<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui-bundle.js"></script>
				<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui.css" />
				<title>Documentation</title>
		</head>
		<body>
				<div id="swagger-ui"></div>
				<script>
						window.onload = function() {
							SwaggerUIBundle({
								url: "${url}",
								dom_id: '#swagger-ui',
								presets: [
									SwaggerUIBundle.presets.apis,
									SwaggerUIStandalonePreset
								],
								layout: "BaseLayout",
                ${persistAuthString}
							})
						}
				</script>
		</body>
		</html>`;
  }

  rapidoc(url: string, style = "view") {
    return (
      `
    <!doctype html> <!-- Important: must specify -->
    <html>
      <head>
        <meta charset="utf-8"> <!-- Important: rapi-doc uses utf8 characters -->
        <script type="module" src="https://unpkg.com/rapidoc/dist/rapidoc-min.js"></script>
        <title>Documentation</title>
      </head>
      <body>
        <rapi-doc
          spec-url = "` +
      url +
      `"
      theme = "dark"
      bg-color = "#24283b"
      header-color = "#1a1b26"
      nav-hover-bg-color = "#1a1b26"
      nav-bg-color = "#24283b"
      text-color = "#c0caf5"
      nav-text-color = "#c0caf5"
      primary-color = "#9aa5ce"
      heading-text = "Documentation"
      sort-tags = "true"
      render-style = "` +
      style +
      `"
      default-schema-tab = "example"
      show-components = "true"
      allow-spec-url-load = "false"
      allow-spec-file-load = "false"
      sort-endpoints-by = "path"

        > </rapi-doc>
      </body>
    </html>
    `
    );
  }

  async writeFile(routes: any, options: options) {
    const contents = await this.generate(routes, options);
    const filePath = options.path + "swagger.yml";
    fs.writeFileSync(filePath, contents);
  }

  private async readFile(rootPath) {
    const filePath = rootPath + "swagger.yml";
    const data = fs.readFileSync(filePath, "utf-8");
    if (!data) {
      console.error("Error reading file");
      return;
    }
    return data;
  }

  async docs(routes: any, options: options) {
    if (process.env.NODE_ENV === "production") {
      return this.readFile(options.path);
    }
    return this.generate(routes, options);
  }

  async generate(adonisRoutes: AdonisRoutes, options: options) {
    this.options = {
      ...{
        snakeCase: true,
        preferredPutPatch: "PUT",
      },
      ...options,
    };
    const routes = adonisRoutes.root;
    this.options.path = this.options.path + "app";
    this.schemas = await this.getSchemas();

    const docs = {
      openapi: "3.0.0",
      info: {
        title: options.title,
        version: options.version,
      },

      components: {
        responses: {
          Forbidden: {
            description: "Access token is missing or invalid",
          },
          Accepted: {
            description: "The request was accepted",
          },
          Created: {
            description: "The resource has been created",
          },
          NotFound: {
            description: "The resource has been created",
          },
          NotAcceptable: {
            description: "The resource has been created",
          },
        },
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
        schemas: this.schemas,
      },
      paths: {},
      tags: [],
    };
    let paths = {};

    let securities = {
      "auth": { BearerAuth: ["access"] },
      "auth:api": { BearerAuth: ["access"] },
    };

    let globalTags = [];
    for await (const route of routes) {
      if (options.ignore.includes(route.pattern)) continue;

      let security = [];
      const responseCodes = {
        GET: "200",
        POST: "201",
        DELETE: "202",
        PUT: "204",
      };

      if (!Array.isArray(route.middleware)) {
        route.middleware = serializeV6Middleware(route.middleware) as string[];
      }

      (route.middleware as string[]).forEach((m) => {
        if (typeof securities[m] !== "undefined") {
          security.push(securities[m]);
        }
      });

      let sourceFile = "";
      let action = "";
      let customAnnotations;
      let operationId = "";
      if (
        route.meta.resolvedHandler !== null &&
        route.meta.resolvedHandler !== undefined
      ) {
        if (
          typeof route.meta.resolvedHandler.namespace !== "undefined" &&
          route.meta.resolvedHandler.method !== "handle"
        ) {
          sourceFile = route.meta.resolvedHandler.namespace;

          action = route.meta.resolvedHandler.method;
          // If not defined by an annotation, use the combination of "controllerNameMethodName"
          if (action !== "" && isUndefined(operationId) && route.handler) {
            operationId = formatOperationId(route.handler as string);
          }

          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        }
      }

      let v6handler = <v6Handler>route.handler;
      if (
        v6handler.reference !== null &&
        v6handler.reference !== undefined &&
        v6handler.reference !== ""
      ) {
        if (!Array.isArray(v6handler.reference)) {
          const split = v6handler.reference.split(".");
          sourceFile = split[0];
          action = split[1];
          operationId = formatOperationId(v6handler.reference);
          sourceFile = options.path + "app/controllers/" + sourceFile;
          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        } else {
          v6handler = await serializeV6Handler(v6handler);
          action = v6handler.method;
          sourceFile = v6handler.moduleNameOrPath;
          sourceFile = sourceFile.replace("#", "");
          sourceFile = options.path + "app/" + sourceFile;
          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        }
      }

      let { tags, parameters, pattern } = this.extractInfos(route.pattern);

      tags.forEach((tag) => {
        if (globalTags.filter((e) => e.name === tag).length > 0) return;
        if (tag === "") return;
        globalTags.push({
          name: tag,
          description: "Everything related to " + tag,
        });
      });

      route.methods.forEach((method) => {
        let responses = {};
        if (method === "HEAD") return;

        if (
          route.methods.includes("PUT") &&
          route.methods.includes("PATCH") &&
          method !== this.options.preferredPutPatch
        )
          return;

        let description = "";
        let summary = "";
        let operationId: string;

        if (security.length > 0) {
          responses["401"] = {
            description: HTTPStatusCode.getMessage(401),
          };
          responses["403"] = {
            description: HTTPStatusCode.getMessage(403),
          };
        }

        let requestBody = {
          content: {
            "application/json": {},
          },
        };

        let actionParams = {};

        if (action !== "" && typeof customAnnotations[action] !== "undefined") {
          description = customAnnotations[action].description;
          summary = customAnnotations[action].summary;
          operationId = customAnnotations[action].operationId;
          responses = { ...responses, ...customAnnotations[action].responses };
          requestBody = customAnnotations[action].requestBody;
          actionParams = customAnnotations[action].parameters;
        }
        parameters = this.mergeParams(parameters, actionParams);

        if (isEmpty(responses)) {
          responses[responseCodes[method]] = {
            description: HTTPStatusCode.getMessage(responseCodes[method]),
            content: {
              "application/json": {},
            },
          };
        } else {
          if (
            typeof responses[responseCodes[method]] !== "undefined" &&
            typeof responses[responseCodes[method]]["summary"] !== "undefined"
          ) {
            if (summary === "") {
              summary = responses[responseCodes[method]]["summary"];
            }
            delete responses[responseCodes[method]]["summary"];
          }
          if (
            typeof responses[responseCodes[method]] !== "undefined" &&
            typeof responses[responseCodes[method]]["description"] !==
              "undefined"
          ) {
            description = responses[responseCodes[method]]["description"];
          }
        }

        if (action !== "" && summary === "") {
          // Solve toLowerCase undefined exception
          // https://github.com/ad-on-is/adonis-autoswagger/issues/28
          tags[0] = tags[0] ?? "";

          switch (action) {
            case "index":
              summary = "Get a list of " + tags[0].toLowerCase();
              break;
            case "show":
              summary = "Get a single instance of " + tags[0].toLowerCase();
              break;
            case "update":
              summary = "Update " + tags[0].toLowerCase();
              break;
            case "destroy":
              summary = "Delete " + tags[0].toLowerCase();
              break;
          }
        }

        let m = {
          summary:
            sourceFile === "" && action == ""
              ? summary + " (route.ts)"
              : summary +
                " (" +
                sourceFile.replace("App/Controllers/Http/", "") +
                "::" +
                action +
                ")",
          description: description,
          operationId: operationId,
          parameters: parameters,
          tags: tags,
          responses: responses,
          security: security,
        };

        if (method !== "GET" && method !== "DELETE") {
          m["requestBody"] = requestBody;
        }

        pattern = pattern.slice(1);
        if (pattern === "") {
          pattern = "/";
        }

        paths = {
          ...paths,
          [pattern]: { ...paths[pattern], [method.toLowerCase()]: m },
        };
      });

      docs.tags = globalTags;
      docs.paths = paths;
    }
    return YAML.stringify(docs);
  }

  private mergeParams(initial, custom) {
    let merge = Object.assign(initial, custom);
    let params = [];
    for (const [key, value] of Object.entries(merge)) {
      params.push(value);
    }

    return params;
  }

  private async getCustomAnnotations(file: string, action: string) {
    let annotations = {};
    if (typeof file === "undefined") return;
    if (typeof this.parsedFiles[file] !== "undefined") return;
    this.parsedFiles.push(file);
    file = file.replace("App/", "app/") + ".ts";
    const readFile = util.promisify(fs.readFile);
    const data = await readFile(file, "utf8");
    const comments = extract(data);
    if (comments.length > 0) {
      comments.forEach((comment) => {
        if (comment.type !== "BlockComment") return;
        if (!comment.value.includes("@" + action)) return;
        let lines = comment.value.split("\n").map((l) => l.trim());
        lines = lines.filter((l) => l != "");

        annotations[action] = this.parseAnnotations(lines);
      });
    }
    return annotations;
  }

  private parseAnnotations(lines: string[]) {
    let summary = "";
    let upload = "";
    let description = "";
    let operationId;
    let responses = {};
    let requestBody;
    let parameters = {};
    let headers = {};

    lines.forEach((line) => {
      if (line.startsWith("@summary")) {
        summary = line.replace("@summary ", "");
      }

      if (line.startsWith("@description")) {
        description = line.replace("@description ", "");
      }

      if (line.startsWith("@operationId")) {
        operationId = line.replace("@operationId ", "");
      }

      if (line.startsWith("@responseBody")) {
        responses = { ...responses, ...this.parseResponse(line) };
      }
      if (line.startsWith("@responseHeader")) {
        const header = this.parseResponseHeader(line);
        if (header === null) {
          console.error("Error with line: " + line);
          return;
        }
        headers[header["status"]] = {
          ...headers[header["status"]],
          ...header["header"],
        };
      }
      if (line.startsWith("@requestBody")) {
        requestBody = this.parseRequestBody(line);
      }
      if (line.startsWith("@requestFormDataBody")) {
        const parsedBody = this.parseRequestFormDataBody(line);
        if (parsedBody) {
          requestBody = parsedBody;
        }
      }
      if (line.startsWith("@param")) {
        parameters = { ...parameters, ...this.parseParam(line) };
      }
    });

    for (const [key, value] of Object.entries(responses)) {
      if (typeof headers[key] !== undefined) {
        responses[key]["headers"] = headers[key];
      }
    }

    return {
      description,
      responses,
      requestBody,
      parameters,
      summary,
      operationId,
    };
  }

  private parseParam(line: string) {
    let where = "path";
    let required = true;
    let type = "string";
    let example: any = null;
    let enums = [];

    if (line.startsWith("@paramUse")) {
      let use = this.getBetweenBrackets(line, "paramUse");
      const used = use.split(",");
      let h = [];
      used.forEach((u) => {
        if (typeof this.options.common.parameters[u] === "undefined") {
          return;
        }
        const common = this.options.common.parameters[u];
        h = [...h, ...common];
      });

      return h;
    }

    if (line.startsWith("@paramPath")) {
      required = true;
    }
    if (line.startsWith("@paramQuery")) {
      required = false;
    }

    let m = line.match("@param([a-zA-Z]*)");
    if (m !== null) {
      where = m[1].toLowerCase();
      line = line.replace(m[0] + " ", "");
    }

    let [param, des, meta] = line.split(" - ");
    if (typeof param === "undefined") {
      return;
    }
    if (typeof des === "undefined") {
      des = "";
    }

    if (typeof meta !== "undefined") {
      if (meta.includes("@required")) {
        required = true;
      }
      let en = this.getBetweenBrackets(meta, "enum");
      example = this.getBetweenBrackets(meta, "example");
      const mtype = this.getBetweenBrackets(meta, "type");
      if (mtype !== "") {
        type = mtype;
      }
      if (en !== "") {
        enums = en.split(",");
        example = enums[0];
      }
    }

    if (example === "" || example === null) {
      switch (type) {
        case "string":
          example = "string";
          break;
        case "integer":
          example = 1;
          break;
        case "float":
          example = 1.5;
          break;
      }
    }

    let p = {
      in: where,
      name: param,
      description: des,
      schema: {
        example: example,
        type: type,
      },
      required: required,
    };

    if (enums.length > 1) {
      p["schema"]["enum"] = enums;
    }

    return { [param]: p };
  }

  private parseResponseHeader(responseLine: string) {
    let description = "";
    let example: any = "";
    let type = "string";
    let enums = [];
    const line = responseLine.replace("@responseHeader ", "");
    let [status, name, desc, meta] = line.split(" - ");

    if (typeof status === "undefined" || typeof name === "undefined") {
      return null;
    }

    if (typeof desc !== "undefined") {
      description = desc;
    }

    if (name.includes("@use")) {
      let use = this.getBetweenBrackets(name, "use");
      const used = use.split(",");
      let h = {};
      used.forEach((u) => {
        if (typeof this.options.common.headers[u] === "undefined") {
          return;
        }
        const common = this.options.common.headers[u];
        h = { ...h, ...common };
      });

      return {
        status: status,
        header: h,
      };
    }

    if (typeof meta !== "undefined") {
      example = this.getBetweenBrackets(meta, "example");
      const mtype = this.getBetweenBrackets(meta, "type");
      if (mtype !== "") {
        type = mtype;
      }
    }

    if (example === "" || example === null) {
      switch (type) {
        case "string":
          example = "string";
          break;
        case "integer":
          example = 1;
          break;
        case "float":
          example = 1.5;
          break;
      }
    }

    let h = {
      schema: { type: type, example: example },
      description: description,
    };

    if (enums.length > 1) {
      h["schema"]["enum"] = enums;
    }
    return {
      status: status,
      header: {
        [name]: h,
      },
    };
  }

  private parseResponse(responseLine: string) {
    let responses = {};
    const line = responseLine.replace("@responseBody ", "");
    let [status, res] = line.split(" - ");
    let sum = "";
    if (typeof status === "undefined") return;
    responses[status] = {};
    if (typeof res === "undefined") {
      res = HTTPStatusCode.getMessage(status);
    } else {
      res = HTTPStatusCode.getMessage(status) + ": " + res;
      let ref = line.substring(line.indexOf("<") + 1, line.lastIndexOf(">"));
      let json = line.substring(line.indexOf("{") + 1, line.lastIndexOf("}"));
      if (json !== "") {
        try {
          let j = JSON.parse("{" + json + "}");
          j = this.jsonToRef(j);
          responses[status]["content"] = {
            "application/json": {
              schema: {
                type: "object",
              },
              example: j,
            },
          };
        } catch {
          console.error("Invalid JSON for: " + line);
        }
      }
      // references a schema
      if (typeof ref !== "undefined" && ref !== "") {
        const inc = this.getBetweenBrackets(res, "with");
        const exc = this.getBetweenBrackets(res, "exclude");
        const only = this.getBetweenBrackets(res, "only");
        const append = this.getBetweenBrackets(res, "append");
        let app = {};
        try {
          app = JSON.parse("{" + append + "}");
        } catch {}

        res = sum = "Returns a **single** instance of type `" + ref + "`";
        // references a schema array
        if (ref.includes("[]")) {
          ref = ref.replace("[]", "");
          res = sum = "Returns a **list** of type `" + ref + "`";
          responses[status]["content"] = {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/" + ref },
              },
              example: [
                Object.assign(
                  this.getSchemaExampleBasedOnAnnotation(ref, inc, exc, only),
                  app
                ),
              ],
            },
          };
        } else {
          responses[status]["content"] = {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + ref },
              example: Object.assign(
                this.getSchemaExampleBasedOnAnnotation(ref, inc, exc, only),
                app
              ),
            },
          };
        }
        if (only !== "") {
          res += " **only containing** _" + only.replace(/,/g, ", ") + "_";
        }
        if (inc !== "") {
          res += " **including** _" + inc.replace(/,/g, ", ") + "_";
        } else {
          res += " **without** any _relations_";
        }
        if (exc !== "") {
          res += " and **excludes** _" + exc.replace(/,/g, ", ") + "_";
        }
        res += ". Take a look at the example for further details.";
      }
    }
    responses[status]["description"] = res;
    // responses[status]['summary'] = sum
    return responses;
  }

  private jsonToRef(json) {
    let out = {};
    for (let [k, v] of Object.entries(json)) {
      if (typeof v === "object") {
        if (!Array.isArray(v)) {
          v = this.jsonToRef(v);
        }
      }
      if (typeof v === "string") {
        let ref = v.substring(v.indexOf("<") + 1, v.lastIndexOf(">"));
        if (ref !== "") {
          const inc = this.getBetweenBrackets(v, "with");
          const exc = this.getBetweenBrackets(v, "exclude");
          const append = this.getBetweenBrackets(v, "append");
          const only = this.getBetweenBrackets(v, "only");

          let app = {};
          try {
            app = JSON.parse("{" + append + "}");
          } catch {}

          // references a schema array
          if (ref.includes("[]")) {
            ref = ref.replace("[]", "");
            v = [
              Object.assign(
                this.getSchemaExampleBasedOnAnnotation(ref, inc, exc, only),
                app
              ),
            ].reduce((a) => a);
          } else {
            v = Object.assign(
              this.getSchemaExampleBasedOnAnnotation(ref, inc, exc, only),
              app
            );
          }
        }
      }
      out[k] = v;
    }
    return out;
  }

  private parseRequestBody(rawLine: string) {
    const line = rawLine.replace("@requestBody ", "");

    const isJson = isJSONString(line);

    if (isJson) {
      // No need to try/catch this JSON.parse as we already did that in the isJSONString function
      const json = JSON.parse(line);

      return {
        content: {
          "application/json": {
            schema: {
              type: "object",
            },
            example: this.jsonToRef(json),
          },
        },
      };
    }

    let rawRef = line.substring(line.indexOf("<") + 1, line.lastIndexOf(">"));

    if (rawRef === "") {
      // No format valid, returning empty responseBody
      return;
    }

    const inc = this.getBetweenBrackets(line, "with");
    const exc = this.getBetweenBrackets(line, "exclude");
    const append = this.getBetweenBrackets(line, "append");
    const only = this.getBetweenBrackets(line, "only");

    let app = {};
    try {
      app = JSON.parse("{" + append + "}");
    } catch {}

    // references a schema array
    if (rawRef.includes("[]")) {
      const cleandRef = rawRef.replace("[]", "");

      return {
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: { $ref: "#/components/schemas/" + cleandRef },
            },
            example: [
              Object.assign(
                this.getSchemaExampleBasedOnAnnotation(
                  cleandRef,
                  inc,
                  exc,
                  only
                ),
                app
              ),
            ],
          },
        },
      };
    }

    return {
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/" + rawRef,
          },
          example: Object.assign(
            this.getSchemaExampleBasedOnAnnotation(rawRef, inc, exc, only),
            app
          ),
        },
      },
    };
  }

  private parseRequestFormDataBody(rawLine: string) {
    const line = rawLine.replace("@requestFormDataBody ", "");

    const isJson = isJSONString(line);

    if (!isJson) {
      return;
    }

    // No need to try/catch this JSON.parse as we already did that in the isJSONString function
    const json = JSON.parse(line);

    return {
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: json,
          },
        },
      },
    };
  }

  private getBetweenBrackets(value: string, start: string) {
    let match = value.match(new RegExp(start + "\\(([^()]*)\\)", "g"));

    if (match !== null) {
      let m = match[0].replace(start + "(", "").replace(")", "");

      if (start !== "example") {
        m = m.replace(/ /g, "");
      }

      return m;
    }
    return "";
  }

  private getSchemaExampleBasedOnAnnotation(
    schema: string,
    inc = "",
    exc = "",
    onl = "",
    first = "",
    parent = "",
    level = 0
  ) {
    let props = {};
    if (!this.schemas[schema]) {
      return props;
    }
    let properties = this.schemas[schema].properties;
    let include = inc.toString().split(",");
    let exclude = exc.toString().split(",");
    let only = onl.toString().split(",");

    only = only.length === 1 && only[0] === "" ? [] : only;

    if (typeof properties === "undefined") return;

    // skip nested if not requested
    if (
      parent !== "" &&
      schema !== "" &&
      parent.includes(".") &&
      this.schemas[schema].description === "Model" &&
      !inc.includes(parent) &&
      !inc.includes(parent + ".relations") &&
      !inc.includes(first + ".relations")
    ) {
      return null;
    }
    for (const [key, value] of Object.entries(properties)) {
      let isArray = false;

      if (exclude.includes(key)) continue;
      if (exclude.includes(parent + "." + key)) continue;

      if (
        key === "password" &&
        !include.includes("password") &&
        !only.includes("password")
      )
        continue;
      if (
        key === "password_confirmation" &&
        !include.includes("password_confirmation") &&
        !only.includes("password_confirmation")
      )
        continue;
      if (
        (key === "created_at" ||
          key === "updated_at" ||
          key === "deleted_at") &&
        exc.includes("timestamps")
      )
        continue;

      let rel = "";
      let example = value["example"];

      if (parent === "" && only.length > 0 && !only.includes(key)) continue;

      if (typeof value["$ref"] !== "undefined") {
        rel = value["$ref"].replace("#/components/schemas/", "");
      }

      if (
        typeof value["items"] !== "undefined" &&
        typeof value["items"]["$ref"] !== "undefined"
      ) {
        rel = value["items"]["$ref"].replace("#/components/schemas/", "");
      }

      if (typeof value["items"] !== "undefined") {
        isArray = true;
        example = value["items"]["example"];
      }

      if (rel !== "") {
        // skip related models of main schema
        if (
          parent === "" &&
          rel !== "" &&
          typeof this.schemas[rel] !== "undefined" &&
          this.schemas[rel].description === "Model" &&
          !include.includes("relations") &&
          !include.includes(key)
        ) {
          continue;
        }

        if (
          typeof value["items"] !== "undefined" &&
          typeof value["items"]["$ref"] !== "undefined"
        ) {
          rel = value["items"]["$ref"].replace("#/components/schemas/", "");
        }
        if (rel == "") {
          return;
        }

        let propdata: any = "";
        if (level <= 10) {
          propdata = this.getSchemaExampleBasedOnAnnotation(
            rel,
            inc,
            exc,
            onl,
            parent,
            parent === "" ? key : parent + "." + key,
            level++
          );
        }

        if (propdata === null) {
          continue;
        }

        props[key] = isArray ? [propdata] : propdata;
      } else {
        props[key] = isArray ? [example] : example;
      }
    }

    return props;
  }

  /*
    extract path-variables, tags and the uri-pattern
  */
  private extractInfos(p: string) {
    let parameters = {};
    let pattern = "";
    let tags = [];
    let required: boolean;

    const split = p.split("/");
    if (split.length > this.options.tagIndex) {
      tags = [split[this.options.tagIndex].toUpperCase()];
    }
    split.forEach((part) => {
      if (part.startsWith(":")) {
        required = !part.endsWith("?");
        const param = part.replace(":", "").replace("?", "");
        part = "{" + param + "}";
        parameters = {
          ...parameters,
          [param]: {
            in: "path",
            name: param,
            schema: {
              type: "string",
            },
            required: required,
          },
        };
      }
      pattern += "/" + part;
    });
    if (pattern.endsWith("/")) {
      pattern = pattern.slice(0, -1);
    }
    return { tags, parameters, pattern };
  }

  private async getSchemas() {
    let schemas = {
      Any: {
        description: "Any JSON object not defined as schema",
      },
    };

    schemas = {
      ...schemas,
      ...(await this.getInterfaces()),
      ...(await this.getModels()),
    };

    return schemas;
  }

  private async getModels() {
    const models = {};
    let p = path.join(this.options.path, "/Models");
    const p6 = path.join(this.options.path, "/models");
    if (!existsSync(p) && !existsSync(p6)) {
      return models;
    }
    if (existsSync(p6)) {
      p = p6;
    }
    const files = await this.getFiles(p, []);
    const readFile = util.promisify(fs.readFile);
    for (let file of files) {
      const data = await readFile(file, "utf8");
      file = file.replace(".ts", "");
      const split = file.split("/");
      let name = split[split.length - 1].replace(".ts", "");
      file = file.replace("app/", "/app/");
      const parsed = this.parseModelProperties(data);
      if (parsed.name !== "") {
        name = parsed.name;
      }
      let schema = {
        type: "object",
        properties: parsed.props,
        description: "Model",
      };
      models[name] = schema;
    }
    return models;
  }

  private async getInterfaces() {
    let interfaces = {};
    let p = path.join(this.options.path, "/Interfaces");
    const p6 = path.join(this.options.path, "/interfaces");
    if (!existsSync(p) && !existsSync(p6)) {
      return interfaces;
    }
    if (existsSync(p6)) {
      p = p6;
    }
    const files = await this.getFiles(p, []);
    const readFile = util.promisify(fs.readFile);
    for (let file of files) {
      const data = await readFile(file, "utf8");
      file = file.replace(".ts", "");
      const split = file.split("/");
      const name = split[split.length - 1].replace(".ts", "");
      file = file.replace("app/", "/app/");
      interfaces = { ...interfaces, ...this.parseInterfaces(data) };
    }
    return interfaces;
  }

  private parseInterfaces(data) {
    let interfaces = {};
    let name = "";
    let props = {};
    // remove empty lines
    data = data.replace(/\t/g, "").replace(/^(?=\n)$|^\s*|\s*$|\n\n+/gm, "");
    const lines = data.split("\n");
    lines.forEach((line, index) => {
      line = line.trim();

      if (
        line.startsWith("//") ||
        line.startsWith("/*") ||
        line.startsWith("*")
      )
        return;
      if (
        line.startsWith("interface ") ||
        line.startsWith("export default interface ") ||
        line.startsWith("export interface ")
      ) {
        props = {};
        name = line;
        name = name.replace("export default ", "");
        name = name.replace("export ", "");
        name = name.replace("interface ", "");
        name = name.replace("{", "");
        name = name.trim();
        return;
      }

      if (line === "}") {
        if (name === "") return;
        interfaces[name] = {
          type: "object",
          properties: props,
          description: "Interface",
        };
        return;
      }

      let meta = "";
      if (index > 0) {
        meta = lines[index - 1];
      }

      const s = line.split(":");
      let field = s[0];
      let type = s[1];
      let notRequired = false;

      if (!field || !type) return;

      if (field.endsWith("?")) {
        field = field.replace("?", "");
        notRequired = true;
      }

      let en = this.getBetweenBrackets(meta, "enum");
      let example = this.getBetweenBrackets(meta, "example");
      let enums = [];
      if (example === "") {
        example = this.examples(field);
      }
      if (en !== "") {
        enums = en.split(",");
        example = enums[0];
      }

      field = field.trim();
      type = type.trim();
      if (this.options.snakeCase) {
        field = snakeCase(field);
      }
      let isArray = false;
      if (type.includes("[]")) {
        type = type.replace("[]", "");
        isArray = true;
      }
      let indicator = "type";
      let prop = {};

      if (type.toLowerCase() === "datetime") {
        prop[indicator] = "string";
        prop["format"] = "date-time";
        prop["example"] = "2021-03-23T16:13:08.489+01:00";
        prop["nullable"] = notRequired;
      } else if (type.toLowerCase() === "date") {
        prop[indicator] = "string";
        prop["format"] = "date";
        prop["example"] = "2021-03-23";
        prop["nullable"] = notRequired;
      } else {
        if (!this.standardTypes.includes(type)) {
          indicator = "$ref";
          type = "#/components/schemas/" + type;
        }

        prop[indicator] = type;
        prop["example"] = example;
        prop["nullable"] = notRequired;
      }

      if (isArray) {
        props[field] = { type: "array", items: prop };
      } else {
        props[field] = prop;
      }
      if (enums.length > 0) {
        props[field]["enum"] = enums;
      }
    });

    return interfaces;
  }

  private parseModelProperties(data) {
    let props = {};
    // remove empty lines
    data = data.replace(/\t/g, "").replace(/^(?=\n)$|^\s*|\s*$|\n\n+/gm, "");
    const lines = data.split("\n");
    let softDelete = false;
    let name = "";
    lines.forEach((line, index) => {
      line = line.trim();
      // skip comments
      if (line.startsWith("export default class")) {
        name = line.split(" ")[3];
      }
      if (
        line.includes("@swagger-softdelete") ||
        line.includes("SoftDeletes")
      ) {
        softDelete = true;
      }
      if (
        line.startsWith("//") ||
        line.startsWith("/*") ||
        line.startsWith("*")
      )
        return;
      if (index > 0 && lines[index - 1].includes("serializeAs: null")) return;
      if (index > 0 && lines[index - 1].includes("@no-swagger")) return;
      if (
        !line.startsWith("public ") &&
        !line.startsWith("public get") &&
        !line.startsWith("declare ")
      )
        return;
      if (line.includes("(") && !line.startsWith("public get")) return;

      let s = [];

      if (line.startsWith("declare ")) {
        s = line.split("declare ");
      }
      if (line.startsWith("public ")) {
        if (line.startsWith("public get")) {
          s = line.split("public get");
          let s2 = s[1].replace(/;/g, "").split(":");
        } else {
          s = line.split("public ");
        }
      }

      let s2 = s[1].replace(/;/g, "").split(":");

      let field = s2[0];
      let type = s2[1];
      let enums = [];
      let format = "";
      let example: any = this.examples(field);
      if (index > 0 && lines[index - 1].includes("@enum")) {
        const l = lines[index - 1];
        let en = this.getBetweenBrackets(l, "enum");
        if (en !== "") {
          enums = en.split(",");
          example = enums[0];
        }
      }

      if (index > 0 && lines[index - 1].includes("@example")) {
        const l = lines[index - 1];
        let match = l.match(/example\(([^()]*)\)/g);
        if (match !== null) {
          const m = match[0].replace("example(", "").replace(")", "");
          example = m;
        }
      }

      if (typeof type === "undefined") {
        type = "string";
        format = "";
      }

      field = field.trim();

      type = type.trim();

      //TODO: make oneOf
      if (type.includes(" | ")) {
        const types = type.split(" | ");
        type = types.filter((t) => t !== "null")[0];
      }

      field = field.replace("()", "");
      field = field.replace("get ", "");
      type = type.replace("{", "").trim();

      if (this.options.snakeCase) {
        field = snakeCase(field);
      }

      let indicator = "type";

      if (example === null) {
        example = "string";
      }

      // if relation to another model
      if (type.includes("typeof")) {
        s = type.split("typeof ");
        type = "#/components/schemas/" + s[1].slice(0, -1);
        indicator = "$ref";
      } else {
        if (this.standardTypes.includes(type.toLowerCase())) {
          type = type.toLowerCase();
        } else {
          // assume its a custom interface
          indicator = "$ref";
          type = "#/components/schemas/" + type;
        }
      }
      type = type.trim();
      let isArray = false;

      if (
        line.includes("HasMany") ||
        line.includes("ManyToMany") ||
        line.includes("HasManyThrough") ||
        type.includes("[]")
      ) {
        isArray = true;
        if (type.slice(type.length - 2, type.length) === "[]") {
          type = type.split("[]")[0];
        }
      }

      if (type === "datetime") {
        indicator = "type";
        type = "string";
        format = "date-time";
        example = "2021-03-23T16:13:08.489+01:00";
      }

      if (type === "date") {
        indicator = "type";
        type = "string";
        format = "date";
        example = "2021-03-23";
      }

      if (field === "email") {
        indicator = "type";
        type = "string";
        format = "email";
        example = "johndoe@example.com";
      }
      if (field === "password") {
        indicator = "type";
        type = "string";
        format = "password";
      }

      if (type === "any") {
        indicator = "$ref";
        type = "#/components/schemas/Any";
      }

      let prop = {};
      if (type === "integer" || type === "number") {
        if (example === null || example === "string") {
          example = Math.floor(Math.random() * 1000);
        }
      }
      if (type === "boolean") {
        example = true;
      }

      prop[indicator] = type;
      prop["example"] = example;
      // if array
      if (isArray) {
        props[field] = { type: "array", items: prop };
      } else {
        props[field] = prop;
        if (format !== "") {
          props[field]["format"] = format;
        }
      }
      if (enums.length > 0) {
        props[field]["enum"] = enums;
      }
    });

    if (softDelete) {
      props["deleted_at"] = {
        type: "string",
        format: "date-time",
        example: "2021-03-23T16:13:08.489+01:00",
      };
    }

    return { name: name, props: props };
  }

  private examples(field) {
    const ex = {
      title: "Lorem Ipsum",
      description: "Lorem ipsum dolor sit amet",
      name: "John Doe",
      full_name: "John Doe",
      first_name: "John",
      last_name: "Doe",
      email: "johndoe@example.com",
      address: "1028 Farland Street",
      street: "1028 Farland Street",
      country: "United States of America",
      country_code: "US",
      zip: 60617,
      city: "Chicago",
      password: "S3cur3P4s5word!",
      password_confirmation: "S3cur3P4s5word!",
      lat: 41.705,
      long: -87.475,
      price: 10.5,
      avatar: "https://example.com/avatar.png",
      url: "https://example.com",
    };
    if (typeof ex[field] === "undefined") {
      return null;
    }
    return ex[field];
  }

  private async getFiles(dir, files_) {
    const fs = require("fs");
    files_ = files_ || [];
    var files = await fs.readdirSync(dir);
    for (let i in files) {
      var name = dir + "/" + files[i];
      if (fs.statSync(name).isDirectory()) {
        this.getFiles(name, files_);
      } else {
        files_.push(name);
      }
    }
    return files_;
  }
}

function serializeV6Middleware(mw: any): string[] {
  return [...mw.all()].reduce<string[]>((result, one) => {
    if (typeof one === "function") {
      result.push(one.name || "closure");
      return result;
    }

    if ("name" in one && one.name) {
      result.push(one.name);
    }

    return result;
  }, []);
}

async function serializeV6Handler(handler: any): Promise<any> {
  /**
   * Value is a controller reference
   */
  if ("reference" in handler) {
    return {
      type: "controller" as const,
      ...(await parseBindingReference(handler.reference)),
    };
  }

  /**
   * Value is an inline closure
   */
  return {
    type: "closure" as const,
    name: handler.name || "closure",
  };
}

async function parseBindingReference(
  binding: string | [any | any, any]
): Promise<{ moduleNameOrPath: string; method: string }> {
  const parseImports = (await import("parse-imports")).default;
  /**
   * The binding reference is a magic string. It might not have method
   * name attached to it. Therefore we split the string and attempt
   * to find the method or use the default method name "handle".
   */
  if (typeof binding === "string") {
    const tokens = binding.split(".");
    if (tokens.length === 1) {
      return { moduleNameOrPath: binding, method: "handle" };
    }
    return { method: tokens.pop()!, moduleNameOrPath: tokens.join(".") };
  }

  const [bindingReference, method] = binding;

  /**
   * Parsing the binding reference for dynamic imports and using its
   * import value.
   */
  const imports = [...(await parseImports(bindingReference.toString()))];
  const importedModule = imports.find(
    ($import) => $import.isDynamicImport && $import.moduleSpecifier.value
  );
  if (importedModule) {
    return {
      moduleNameOrPath: importedModule.moduleSpecifier.value!,
      method: method || "handle",
    };
  }

  /**
   * Otherwise using the name of the binding reference.
   */
  return {
    moduleNameOrPath: bindingReference.name,
    method: method || "handle",
  };
}
