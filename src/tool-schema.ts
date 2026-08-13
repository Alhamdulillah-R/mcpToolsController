import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { NamespacedTool } from "./types.js";

const validatorProvider = new AjvJsonSchemaValidator();
const validatorCache = new WeakMap<object, JsonSchemaValidator<Record<string, unknown>>>();

export interface ToolArgumentDiagnostic {
  code: "INVALID_ARGUMENT";
  tool: string;
  message: string;
  errors: Array<Record<string, unknown>>;
  allowedFields?: string[];
  requiredOneOf?: string[][];
  example: Record<string, unknown>;
  hint: string;
}

/**
 * Validate a proxied call before sending it downstream and return a model-readable diagnostic.
 * @param tool Aggregated tool definition.
 * @param args Arguments supplied by the MCP client.
 * @returns Null when valid, otherwise a structured correction guide.
 */
export function validateToolArguments(
  tool: NamespacedTool,
  args: Record<string, unknown>,
): ToolArgumentDiagnostic | null {
  const validator = getValidator(tool.inputSchema);
  const result = validator(args);
  if (result.valid) return null;

  const properties = schemaProperties(tool.inputSchema);
  const allowedFields = Object.keys(properties);
  const errors: Array<Record<string, unknown>> = [];

  if (tool.inputSchema.additionalProperties === false) {
    for (const field of Object.keys(args)) {
      if (field in properties) continue;
      const suggestion = suggestField(field, allowedFields);
      errors.push({
        field,
        reason: "unknown_field",
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }

  for (const field of requiredFields(tool.inputSchema)) {
    if (field in args) continue;
    errors.push({ field, reason: "missing_required" });
  }

  for (const [field, value] of Object.entries(args)) {
    const property = properties[field];
    if (!property || typeof property !== "object") continue;
    const enumValues = Array.isArray(property.enum) ? property.enum : undefined;
    if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) {
      errors.push({ field, reason: "invalid_enum", allowedValues: enumValues });
    }
  }

  if (errors.length === 0) {
    errors.push({ reason: "schema_mismatch", detail: result.errorMessage });
  }

  const requiredOneOf = requiredAlternatives(tool.inputSchema);
  return {
    code: "INVALID_ARGUMENT",
    tool: tool.name,
    message: result.errorMessage,
    errors,
    ...(allowedFields.length > 0 ? { allowedFields } : {}),
    ...(requiredOneOf.length > 0 ? { requiredOneOf } : {}),
    example: buildToolExample(tool.inputSchema),
    hint: `Call plugin_tool_schema with {"name":"${tool.name}"} for the complete schema.`,
  };
}

/** Build a compact argument contract that remains visible when a client renders schemas poorly. */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties = schemaProperties(schema);
  const required = new Set(requiredFields(schema));
  const fields = Object.entries(properties).map(([name, raw]) => {
    const property = raw && typeof raw === "object" ? raw : {};
    const type = summarizeType(property);
    return `${name}${required.has(name) ? "" : "?"}:${type}`;
  });
  const alternatives = requiredAlternatives(schema);

  if (fields.length === 0 && alternatives.length === 0) return "Input: {}";
  const parts = fields.length > 0 ? [`Input: { ${fields.join(", ")} }`] : [];
  if (alternatives.length > 0) {
    parts.push(`one of: ${alternatives.map((item) => item.join("+")).join(" | ")}`);
  }
  return parts.join("; ");
}

/** Generate a minimal copy-pasteable argument object from a tool schema. */
export function buildToolExample(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schemaProperties(schema);
  const required = new Set(requiredFields(schema));
  const alternatives = requiredAlternatives(schema);
  if (alternatives.length > 0) {
    const hasAlternative = alternatives.some((fields) => fields.every((field) => required.has(field)));
    if (!hasAlternative) {
      for (const field of alternatives[0]) required.add(field);
    }
  }

  const example: Record<string, unknown> = {};
  for (const field of required) {
    const raw = properties[field];
    example[field] = exampleValue(raw && typeof raw === "object" ? raw : {});
  }
  return example;
}

function getValidator(schema: Record<string, unknown>): JsonSchemaValidator<Record<string, unknown>> {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const validator = validatorProvider.getValidator<Record<string, unknown>>(
    schema as JsonSchemaType,
  );
  validatorCache.set(schema, validator);
  return validator;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (!schema.properties || typeof schema.properties !== "object") return {};
  return schema.properties as Record<string, Record<string, unknown>>;
}

function requiredFields(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema.required)) return [];
  return schema.required.filter((value): value is string => typeof value === "string");
}

function requiredAlternatives(schema: Record<string, unknown>): string[][] {
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  return branches
    .map((branch) => {
      if (!branch || typeof branch !== "object") return [];
      return requiredFields(branch as Record<string, unknown>);
    })
    .filter((fields) => fields.length > 0);
}

function summarizeType(property: Record<string, unknown>): string {
  if (Array.isArray(property.enum)) return property.enum.map(String).join("|");
  if (typeof property.type === "string") return property.type;
  if (Array.isArray(property.type)) return property.type.join("|");
  if (Array.isArray(property.anyOf)) return "union";
  return "unknown";
}

function exampleValue(property: Record<string, unknown>): unknown {
  if ("default" in property) return property.default;
  if (Array.isArray(property.examples) && property.examples.length > 0) return property.examples[0];
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
  switch (property.type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "string";
  }
}

function suggestField(input: string, candidates: string[]): string | undefined {
  const normalizedInput = input.toLowerCase();
  const tokenMatch = candidates.find((field) => {
    const normalizedField = field.toLowerCase();
    return normalizedInput.endsWith(`_${normalizedField}`) || normalizedField.endsWith(`_${normalizedInput}`);
  });
  if (tokenMatch) return tokenMatch;

  let best: { field: string; distance: number } | undefined;
  for (const field of candidates) {
    const distance = levenshtein(normalizedInput, field.toLowerCase());
    if (!best || distance < best.distance) best = { field, distance };
  }
  if (!best) return undefined;
  const limit = Math.max(2, Math.floor(Math.max(input.length, best.field.length) * 0.4));
  return best.distance <= limit ? best.field : undefined;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
