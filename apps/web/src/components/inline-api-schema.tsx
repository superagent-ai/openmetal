"use client";

import type { ReactNode } from "react";

export type SchemaNode = boolean | SchemaObject;

type SchemaObject = {
  $ref?: string;
  additionalProperties?: SchemaNode;
  allOf?: readonly SchemaNode[];
  anyOf?: readonly SchemaNode[];
  default?: unknown;
  deprecated?: boolean;
  description?: string;
  enum?: readonly unknown[];
  examples?: readonly unknown[];
  format?: string;
  items?: SchemaNode;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  oneOf?: readonly SchemaNode[];
  pattern?: string;
  patternProperties?: Record<string, SchemaNode>;
  properties?: Record<string, SchemaNode>;
  readOnly?: boolean;
  required?: readonly string[];
  title?: string;
  type?: string | readonly string[];
  writeOnly?: boolean;
};

type SchemaResolver = (schema: SchemaNode) => SchemaNode;

type InlineApiSchemaProps = {
  client?: {
    as?: "property" | "body";
    name: string;
    required?: boolean;
  };
  root: SchemaNode;
  resolve: SchemaResolver;
  readOnly?: boolean;
  writeOnly?: boolean;
};

type SchemaValueProps = {
  node: SchemaNode;
  resolve: SchemaResolver;
  readOnly: boolean;
  writeOnly: boolean;
  depth: number;
  seenRefs: Set<string>;
};

export function InlineApiSchema({
  client,
  root,
  resolve,
  readOnly = false,
  writeOnly = false,
}: InlineApiSchemaProps) {
  if ((client?.as ?? "property") === "property") {
    const schema = resolve(root);
    return (
      <div className="not-prose py-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="font-medium text-foreground">
            {client?.name ?? "value"}
            <span className={client?.required ? "text-red-400" : "text-muted-foreground"}>
              {client?.required ? "*" : "?"}
            </span>
          </code>
          <code className="text-sm text-muted-foreground">{schemaType(root, resolve)}</code>
        </div>
        {typeof schema === "object" && schema.description ? (
          <p className="mt-2 text-sm text-muted-foreground">{schema.description}</p>
        ) : null}
        {typeof schema === "object" ? <SchemaMetadata schema={schema} /> : null}
        {isNestedSchema(root, resolve) ? (
          <div className="mt-3">
            <NestedSchema
              node={root}
              resolve={resolve}
              readOnly={readOnly}
              writeOnly={writeOnly}
              depth={1}
              seenRefs={new Set()}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="not-prose">
      <SchemaValue
        node={root}
        resolve={resolve}
        readOnly={readOnly}
        writeOnly={writeOnly}
        depth={0}
        seenRefs={new Set()}
      />
    </div>
  );
}

function SchemaValue({ node, resolve, readOnly, writeOnly, depth, seenRefs }: SchemaValueProps) {
  const rawRef = typeof node === "object" ? node.$ref : undefined;
  if (rawRef && seenRefs.has(rawRef)) {
    return <p className="text-sm text-muted-foreground">Recursive reference</p>;
  }

  const nextSeenRefs = new Set(seenRefs);
  if (rawRef) nextSeenRefs.add(rawRef);

  const schema = resolve(node);
  if (typeof schema === "boolean") {
    return <p className="text-sm text-muted-foreground">{schema ? "any" : "never"}</p>;
  }

  const union = schema.oneOf ?? schema.anyOf;
  if (union?.length) {
    return (
      <div className="space-y-3">
        {union.map((item, index) => (
          <details className="rounded-lg border bg-muted/30 p-3" open={depth < 2} key={index}>
            <summary className="cursor-pointer text-sm font-medium">Variant {index + 1}</summary>
            <div className="mt-3">
              <SchemaValue
                node={item}
                resolve={resolve}
                readOnly={readOnly}
                writeOnly={writeOnly}
                depth={depth + 1}
                seenRefs={nextSeenRefs}
              />
            </div>
          </details>
        ))}
      </div>
    );
  }

  if (schema.allOf?.length) {
    return (
      <div className="space-y-3">
        {schema.allOf.map((item, index) => (
          <SchemaValue
            node={item}
            resolve={resolve}
            readOnly={readOnly}
            writeOnly={writeOnly}
            depth={depth + 1}
            seenRefs={nextSeenRefs}
            key={index}
          />
        ))}
      </div>
    );
  }

  if (isObjectSchema(schema)) {
    const properties = [
      ...Object.entries(schema.properties ?? {}),
      ...Object.entries(schema.patternProperties ?? {}),
      ...(schema.additionalProperties === undefined || schema.additionalProperties === false
        ? []
        : ([["[key: string]", schema.additionalProperties]] as const)),
    ].filter(([, property]) => isVisible(property, resolve, readOnly, writeOnly));

    if (properties.length === 0) {
      return <SchemaMetadata schema={schema} />;
    }

    return (
      <div className={depth === 0 ? "divide-y" : "rounded-lg border bg-muted/30 px-3"}>
        {properties.map(([name, property]) => {
          const required = schema.required?.includes(name) ?? false;
          const resolvedProperty = resolve(property);

          return (
            <div className="py-4 first:pt-3 last:pb-3" key={name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <code className="font-medium text-foreground">
                  {name}
                  <span className={required ? "text-red-400" : "text-muted-foreground"}>
                    {required ? "*" : "?"}
                  </span>
                </code>
                <code className="text-sm text-muted-foreground">
                  {schemaType(property, resolve)}
                </code>
                {typeof resolvedProperty === "object" && resolvedProperty.deprecated ? (
                  <span className="text-xs text-yellow-600 dark:text-yellow-400">Deprecated</span>
                ) : null}
              </div>

              {typeof resolvedProperty === "object" ? (
                <>
                  {resolvedProperty.description ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {resolvedProperty.description}
                    </p>
                  ) : null}
                  <SchemaMetadata schema={resolvedProperty} />
                </>
              ) : null}

              {isNestedSchema(property, resolve) ? (
                <details className="mt-3" open={depth < 2}>
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                    {isArraySchema(property, resolve) ? `${name}[]` : name}
                  </summary>
                  <div className="mt-3">
                    <NestedSchema
                      node={property}
                      resolve={resolve}
                      readOnly={readOnly}
                      writeOnly={writeOnly}
                      depth={depth + 1}
                      seenRefs={nextSeenRefs}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  if (isArraySchema(schema, resolve)) {
    return (
      <NestedSchema
        node={schema}
        resolve={resolve}
        readOnly={readOnly}
        writeOnly={writeOnly}
        depth={depth + 1}
        seenRefs={nextSeenRefs}
      />
    );
  }

  return <SchemaMetadata schema={schema} />;
}

function NestedSchema({ node, resolve, readOnly, writeOnly, depth, seenRefs }: SchemaValueProps) {
  const schema = resolve(node);
  if (typeof schema === "object" && schema.type === "array") {
    return (
      <SchemaValue
        node={schema.items ?? true}
        resolve={resolve}
        readOnly={readOnly}
        writeOnly={writeOnly}
        depth={depth}
        seenRefs={seenRefs}
      />
    );
  }

  return (
    <SchemaValue
      node={node}
      resolve={resolve}
      readOnly={readOnly}
      writeOnly={writeOnly}
      depth={depth}
      seenRefs={seenRefs}
    />
  );
}

function SchemaMetadata({ schema }: { schema: SchemaObject }) {
  const metadata: ReactNode[] = [];
  if (schema.format) metadata.push(<SchemaTag label="Format" value={schema.format} key="format" />);
  if (schema.pattern)
    metadata.push(<SchemaTag label="Match" value={schema.pattern} key="pattern" />);
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    metadata.push(
      <SchemaTag
        label="Length"
        value={`${schema.minLength ?? 0}–${schema.maxLength ?? "∞"}`}
        key="length"
      />,
    );
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    metadata.push(
      <SchemaTag
        label="Range"
        value={`${schema.minimum ?? "−∞"}–${schema.maximum ?? "∞"}`}
        key="range"
      />,
    );
  }
  if (schema.enum?.length) {
    metadata.push(
      <SchemaTag label="Values" value={schema.enum.map(formatValue).join(", ")} key="enum" />,
    );
  }
  if (schema.default !== undefined) {
    metadata.push(<SchemaTag label="Default" value={formatValue(schema.default)} key="default" />);
  }

  return metadata.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{metadata}</div> : null;
}

function SchemaTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex gap-2 rounded-lg border bg-muted px-2 py-1 text-xs">
      <span className="font-medium">{label}</span>
      <code className="text-muted-foreground">{value}</code>
    </span>
  );
}

function isVisible(
  node: SchemaNode,
  resolve: SchemaResolver,
  readOnly: boolean,
  writeOnly: boolean,
) {
  const schema = resolve(node);
  if (typeof schema === "boolean") return true;
  if (schema.readOnly && !readOnly) return false;
  if (schema.writeOnly && !writeOnly) return false;
  return true;
}

function isObjectSchema(schema: SchemaObject) {
  return schema.type === "object" || schema.properties !== undefined;
}

function isArraySchema(node: SchemaNode, resolve: SchemaResolver) {
  const schema = resolve(node);
  return typeof schema === "object" && schema.type === "array";
}

function isNestedSchema(node: SchemaNode, resolve: SchemaResolver): boolean {
  const schema = resolve(node);
  if (typeof schema === "boolean") return false;
  if (
    isObjectSchema(schema) ||
    schema.oneOf?.length ||
    schema.anyOf?.length ||
    schema.allOf?.length
  ) {
    return true;
  }
  return schema.type === "array" && isNestedSchema(schema.items ?? true, resolve);
}

function schemaType(node: SchemaNode, resolve: SchemaResolver): string {
  const schema = resolve(node);
  if (typeof schema === "boolean") return schema ? "any" : "never";
  if (schema.oneOf?.length || schema.anyOf?.length) {
    return (schema.oneOf ?? schema.anyOf ?? [])
      .map((item) => schemaType(item, resolve))
      .join(" | ");
  }
  if (schema.allOf?.length) {
    return schema.allOf.map((item) => schemaType(item, resolve)).join(" & ");
  }
  if (schema.type === "array") return `array<${schemaType(schema.items ?? true, resolve)}>`;
  if (schema.type && typeof schema.type !== "string") return schema.type.join(" | ");
  if (schema.type === "object" || schema.properties) return schema.title ?? "object";
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}
