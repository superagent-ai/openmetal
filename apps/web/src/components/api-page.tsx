"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";
import { InlineApiSchema, type SchemaNode } from "@/components/inline-api-schema";

export const OpenAPIPage = createOpenAPIPage({
  schemaUI: {
    render(options, context) {
      const { root, readOnly, writeOnly } = options;
      const { client } = options as typeof options & {
        client?: {
          as?: "property" | "body";
          name: string;
          required?: boolean;
        };
      };

      return (
        <InlineApiSchema
          client={client}
          root={root as unknown as SchemaNode}
          resolve={(schema) => context.schema.resolve(schema) as unknown as SchemaNode}
          readOnly={readOnly}
          writeOnly={writeOnly}
        />
      );
    },
  },
});
