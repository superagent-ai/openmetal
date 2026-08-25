export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  metal: {
    Tables: {
      domain_events: {
        Row: {
          actor_id: string
          created_at: string
          cursor: number
          event_id: string
          occurred_at: string
          organization_id: string
          payload: Json
          project_id: string | null
          type: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          cursor?: never
          event_id?: string
          occurred_at?: string
          organization_id: string
          payload?: Json
          project_id?: string | null
          type: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          cursor?: never
          event_id?: string
          occurred_at?: string
          organization_id?: string
          payload?: Json
          project_id?: string | null
          type?: string
        }
        Relationships: []
      }
      idempotency_keys: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          key_hash: string
          operation: string
          principal_id: string
          request_fingerprint: string
          response_body: Json | null
          response_status: number | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          key_hash: string
          operation: string
          principal_id: string
          request_fingerprint: string
          response_body?: Json | null
          response_status?: number | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          key_hash?: string
          operation?: string
          principal_id?: string
          request_fingerprint?: string
          response_body?: Json | null
          response_status?: number | null
        }
        Relationships: []
      }
      operation_events: {
        Row: {
          data: Json
          id: string
          occurred_at: string
          operation_id: string
          sequence: number
          type: string
        }
        Insert: {
          data?: Json
          id?: string
          occurred_at?: string
          operation_id: string
          sequence: number
          type: string
        }
        Update: {
          data?: Json
          id?: string
          occurred_at?: string
          operation_id?: string
          sequence?: number
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "operation_events_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "operations"
            referencedColumns: ["id"]
          },
        ]
      }
      operations: {
        Row: {
          completed_at: string | null
          created_at: string
          error: Json | null
          id: string
          organization_id: string
          project_id: string
          public_id: string
          retryable: boolean
          sandbox_id: string
          state: string
          type: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: Json | null
          id?: string
          organization_id: string
          project_id: string
          public_id?: string
          retryable?: boolean
          sandbox_id: string
          state?: string
          type: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: Json | null
          id?: string
          organization_id?: string
          project_id?: string
          public_id?: string
          retryable?: boolean
          sandbox_id?: string
          state?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operations_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_provider_credentials: {
        Row: {
          created_at: string
          created_by: string
          disabled_at: string | null
          id: string
          organization_id: string
          provider: string
          secret_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          disabled_at?: string | null
          id?: string
          organization_id: string
          provider: string
          secret_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          disabled_at?: string | null
          id?: string
          organization_id?: string
          provider?: string
          secret_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      outbox_jobs: {
        Row: {
          attempt_count: number
          available_at: string
          completed_at: string | null
          created_at: string
          dedupe_key: string
          id: string
          job_type: string
          last_error: string | null
          lease_expires_at: string | null
          lease_owner: string | null
          payload: Json
          status: Database["metal"]["Enums"]["outbox_job_status"]
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          dedupe_key: string
          id?: string
          job_type: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          payload: Json
          status?: Database["metal"]["Enums"]["outbox_job_status"]
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string
          id?: string
          job_type?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          payload?: Json
          status?: Database["metal"]["Enums"]["outbox_job_status"]
          updated_at?: string
        }
        Relationships: []
      }
      project_api_keys: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          prefix: string
          project_id: string
          revoked_at: string | null
          secret_hash: string
        }
        Insert: {
          created_at?: string
          created_by: string
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          prefix: string
          project_id: string
          revoked_at?: string | null
          secret_hash: string
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          prefix?: string
          project_id?: string
          revoked_at?: string | null
          secret_hash?: string
        }
        Relationships: []
      }
      provider_attempts: {
        Row: {
          attempt_index: number
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          operation_id: string
          outcome: string | null
          provider: string
          provider_credential_id: string | null
          provider_metadata: Json
          provider_resource_id: string | null
          resolved_resources: Json | null
          sandbox_id: string
          started_at: string | null
          state: string
          updated_at: string
        }
        Insert: {
          attempt_index: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          operation_id: string
          outcome?: string | null
          provider: string
          provider_credential_id?: string | null
          provider_metadata?: Json
          provider_resource_id?: string | null
          resolved_resources?: Json | null
          sandbox_id: string
          started_at?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          attempt_index?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          operation_id?: string
          outcome?: string | null
          provider?: string
          provider_credential_id?: string | null
          provider_metadata?: Json
          provider_resource_id?: string | null
          resolved_resources?: Json | null
          sandbox_id?: string
          started_at?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_attempts_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_attempts_provider_credential_id_fkey"
            columns: ["provider_credential_id"]
            isOneToOne: false
            referencedRelation: "organization_provider_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_attempts_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_cost_snapshots: {
        Row: {
          amount_microusd: number
          captured_at: string
          id: string
          measured_through: string
          organization_id: string
          project_id: string
          provider: string
          provider_resource_id: string
          raw_payload: Json
          sandbox_id: string
        }
        Insert: {
          amount_microusd: number
          captured_at?: string
          id?: string
          measured_through: string
          organization_id: string
          project_id: string
          provider: string
          provider_resource_id: string
          raw_payload: Json
          sandbox_id: string
        }
        Update: {
          amount_microusd?: number
          captured_at?: string
          id?: string
          measured_through?: string
          organization_id?: string
          project_id?: string
          provider?: string
          provider_resource_id?: string
          raw_payload?: Json
          sandbox_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_cost_snapshots_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      sandboxes: {
        Row: {
          billing_mode: string
          created_at: string
          created_by: string
          deleted_at: string | null
          environment: Json
          error_code: string | null
          error_message: string | null
          fallback: Json
          features: Json
          id: string
          image: string | null
          language: string
          lifecycle: Json
          metadata: Json
          network: Json
          organization_id: string
          paused_at: string | null
          primary_provider: string
          project_id: string
          provider: string
          provider_cost_measured_through: string | null
          provider_cost_microusd: number | null
          provider_cost_updated_at: string | null
          provider_credential_id: string | null
          provider_metadata: Json
          provider_options: Json
          provider_organization_id: string | null
          provider_resource_id: string | null
          public_id: string
          ready_at: string | null
          regions: Json
          resolved_resources: Json | null
          resource_requirements: Json
          secret_refs: Json
          source: Json
          status: Database["metal"]["Enums"]["sandbox_status"]
          ttl_minutes: number
          updated_at: string
        }
        Insert: {
          billing_mode?: string
          created_at?: string
          created_by: string
          deleted_at?: string | null
          environment: Json
          error_code?: string | null
          error_message?: string | null
          fallback: Json
          features?: Json
          id?: string
          image?: string | null
          language?: string
          lifecycle: Json
          metadata: Json
          network?: Json
          organization_id: string
          paused_at?: string | null
          primary_provider: string
          project_id: string
          provider?: string
          provider_cost_measured_through?: string | null
          provider_cost_microusd?: number | null
          provider_cost_updated_at?: string | null
          provider_credential_id?: string | null
          provider_metadata?: Json
          provider_options: Json
          provider_organization_id?: string | null
          provider_resource_id?: string | null
          public_id?: string
          ready_at?: string | null
          regions?: Json
          resolved_resources?: Json | null
          resource_requirements: Json
          secret_refs: Json
          source: Json
          status?: Database["metal"]["Enums"]["sandbox_status"]
          ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          billing_mode?: string
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          environment?: Json
          error_code?: string | null
          error_message?: string | null
          fallback?: Json
          features?: Json
          id?: string
          image?: string | null
          language?: string
          lifecycle?: Json
          metadata?: Json
          network?: Json
          organization_id?: string
          paused_at?: string | null
          primary_provider?: string
          project_id?: string
          provider?: string
          provider_cost_measured_through?: string | null
          provider_cost_microusd?: number | null
          provider_cost_updated_at?: string | null
          provider_credential_id?: string | null
          provider_metadata?: Json
          provider_options?: Json
          provider_organization_id?: string | null
          provider_resource_id?: string | null
          public_id?: string
          ready_at?: string | null
          regions?: Json
          resolved_resources?: Json | null
          resource_requirements?: Json
          secret_refs?: Json
          source?: Json
          status?: Database["metal"]["Enums"]["sandbox_status"]
          ttl_minutes?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sandboxes_provider_credential_id_fkey"
            columns: ["provider_credential_id"]
            isOneToOne: false
            referencedRelation: "organization_provider_credentials"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_organization_role: {
        Args: {
          p_organization_id: string
          p_roles: Database["public"]["Enums"]["organization_role"][]
        }
        Returns: boolean
      }
      is_organization_member: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      is_project_member: { Args: { p_project_id: string }; Returns: boolean }
      parse_topic_id: {
        Args: { p_prefix: string; p_topic: string }
        Returns: string
      }
      project_topic_id: { Args: { p_topic: string }; Returns: string }
    }
    Enums: {
      outbox_job_status: "pending" | "leased" | "succeeded" | "failed"
      sandbox_status:
        | "requested"
        | "provisioning"
        | "ready"
        | "pausing"
        | "paused"
        | "provision_unknown"
        | "failed"
        | "deleting"
        | "deleted"
        | "cleanup_pending"
        | "cleanup_failed"
        | "routing"
        | "resuming"
        | "runtime_unknown"
        | "stopping"
        | "stopped"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      organization_members: {
        Row: {
          created_at: string
          organization_id: string
          role: Database["public"]["Enums"]["organization_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role: Database["public"]["Enums"]["organization_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["organization_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          organization_id: string
          public_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          organization_id: string
          public_id?: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          organization_id?: string
          public_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      organization_role: "owner" | "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  metal: {
    Enums: {
      outbox_job_status: ["pending", "leased", "succeeded", "failed"],
      sandbox_status: [
        "requested",
        "provisioning",
        "ready",
        "pausing",
        "paused",
        "provision_unknown",
        "failed",
        "deleting",
        "deleted",
        "cleanup_pending",
        "cleanup_failed",
        "routing",
        "resuming",
        "runtime_unknown",
        "stopping",
        "stopped",
      ],
    },
  },
  public: {
    Enums: {
      organization_role: ["owner", "admin", "member"],
    },
  },
} as const

