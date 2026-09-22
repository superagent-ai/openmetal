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
      auto_topup_attempts: {
        Row: {
          completed_at: string | null
          created_at: string
          credit_microusd: number
          error_code: string | null
          error_message: string | null
          fee_microusd: number
          id: string
          organization_id: string
          purchase_id: string
          status: Database["metal"]["Enums"]["auto_topup_attempt_status"]
          stripe_payment_intent_id: string | null
          total_microusd: number
          window_start: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          credit_microusd: number
          error_code?: string | null
          error_message?: string | null
          fee_microusd: number
          id?: string
          organization_id: string
          purchase_id: string
          status?: Database["metal"]["Enums"]["auto_topup_attempt_status"]
          stripe_payment_intent_id?: string | null
          total_microusd: number
          window_start: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          credit_microusd?: number
          error_code?: string | null
          error_message?: string | null
          fee_microusd?: number
          id?: string
          organization_id?: string
          purchase_id?: string
          status?: Database["metal"]["Enums"]["auto_topup_attempt_status"]
          stripe_payment_intent_id?: string | null
          total_microusd?: number
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_topup_attempts_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "credit_purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      auto_topup_policies: {
        Row: {
          created_at: string
          enabled: boolean
          monthly_cap_microusd: number
          organization_id: string
          paused_reason: string | null
          refill_microusd: number
          status: Database["metal"]["Enums"]["auto_topup_status"]
          threshold_microusd: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          monthly_cap_microusd?: number
          organization_id: string
          paused_reason?: string | null
          refill_microusd?: number
          status?: Database["metal"]["Enums"]["auto_topup_status"]
          threshold_microusd?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          enabled?: boolean
          monthly_cap_microusd?: number
          organization_id?: string
          paused_reason?: string | null
          refill_microusd?: number
          status?: Database["metal"]["Enums"]["auto_topup_status"]
          threshold_microusd?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      billing_accounts: {
        Row: {
          balance_microusd: number
          created_at: string
          organization_id: string
          payment_method_brand: string | null
          payment_method_last4: string | null
          stripe_customer_id: string | null
          stripe_payment_method_id: string | null
          updated_at: string
        }
        Insert: {
          balance_microusd?: number
          created_at?: string
          organization_id: string
          payment_method_brand?: string | null
          payment_method_last4?: string | null
          stripe_customer_id?: string | null
          stripe_payment_method_id?: string | null
          updated_at?: string
        }
        Update: {
          balance_microusd?: number
          created_at?: string
          organization_id?: string
          payment_method_brand?: string | null
          payment_method_last4?: string | null
          stripe_customer_id?: string | null
          stripe_payment_method_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      credit_purchases: {
        Row: {
          actor_id: string
          created_at: string
          credit_microusd: number
          fee_microusd: number
          id: string
          organization_id: string
          paid_at: string | null
          pricing_version_id: string
          source: Database["metal"]["Enums"]["credit_purchase_source"]
          status: Database["metal"]["Enums"]["credit_purchase_status"]
          stripe_checkout_session_id: string | null
          stripe_customer_id: string | null
          stripe_invoice_url: string | null
          stripe_payment_intent_id: string | null
          stripe_receipt_url: string | null
          total_microusd: number
        }
        Insert: {
          actor_id: string
          created_at?: string
          credit_microusd: number
          fee_microusd: number
          id?: string
          organization_id: string
          paid_at?: string | null
          pricing_version_id: string
          source: Database["metal"]["Enums"]["credit_purchase_source"]
          status?: Database["metal"]["Enums"]["credit_purchase_status"]
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_url?: string | null
          stripe_payment_intent_id?: string | null
          stripe_receipt_url?: string | null
          total_microusd: number
        }
        Update: {
          actor_id?: string
          created_at?: string
          credit_microusd?: number
          fee_microusd?: number
          id?: string
          organization_id?: string
          paid_at?: string | null
          pricing_version_id?: string
          source?: Database["metal"]["Enums"]["credit_purchase_source"]
          status?: Database["metal"]["Enums"]["credit_purchase_status"]
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_url?: string | null
          stripe_payment_intent_id?: string | null
          stripe_receipt_url?: string | null
          total_microusd?: number
        }
        Relationships: [
          {
            foreignKeyName: "credit_purchases_pricing_version_id_fkey"
            columns: ["pricing_version_id"]
            isOneToOne: false
            referencedRelation: "pricing_versions"
            referencedColumns: ["id"]
          },
        ]
      }
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
      ledger_entries: {
        Row: {
          account: Database["metal"]["Enums"]["ledger_account"]
          amount_microusd: number
          created_at: string
          id: string
          organization_id: string
          transaction_id: string
        }
        Insert: {
          account: Database["metal"]["Enums"]["ledger_account"]
          amount_microusd: number
          created_at?: string
          id?: string
          organization_id: string
          transaction_id: string
        }
        Update: {
          account?: Database["metal"]["Enums"]["ledger_account"]
          amount_microusd?: number
          created_at?: string
          id?: string
          organization_id?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "ledger_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_transactions: {
        Row: {
          actor_id: string
          created_at: string
          description: string
          id: string
          kind: Database["metal"]["Enums"]["ledger_transaction_kind"]
          organization_id: string
          reference_id: string
          reference_type: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          description: string
          id?: string
          kind: Database["metal"]["Enums"]["ledger_transaction_kind"]
          organization_id: string
          reference_id: string
          reference_type: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          description?: string
          id?: string
          kind?: Database["metal"]["Enums"]["ledger_transaction_kind"]
          organization_id?: string
          reference_id?: string
          reference_type?: string
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
          lease_token: string | null
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
          lease_token?: string | null
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
          lease_token?: string | null
          payload?: Json
          status?: Database["metal"]["Enums"]["outbox_job_status"]
          updated_at?: string
        }
        Relationships: []
      }
      pricing_versions: {
        Row: {
          code: string
          created_at: string
          effective_from: string
          fee_per_mille: number
          id: string
          kind: Database["metal"]["Enums"]["pricing_kind"]
          min_fee_microusd: number
        }
        Insert: {
          code: string
          created_at?: string
          effective_from?: string
          fee_per_mille?: number
          id?: string
          kind: Database["metal"]["Enums"]["pricing_kind"]
          min_fee_microusd?: number
        }
        Update: {
          code?: string
          created_at?: string
          effective_from?: string
          fee_per_mille?: number
          id?: string
          kind?: Database["metal"]["Enums"]["pricing_kind"]
          min_fee_microusd?: number
        }
        Relationships: []
      }
      process_events: {
        Row: {
          data: Json
          id: string
          occurred_at: string
          process_id: string
          sequence: number
          type: string
        }
        Insert: {
          data?: Json
          id?: string
          occurred_at?: string
          process_id: string
          sequence: number
          type: string
        }
        Update: {
          data?: Json
          id?: string
          occurred_at?: string
          process_id?: string
          sequence?: number
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "process_events_process_id_fkey"
            columns: ["process_id"]
            isOneToOne: false
            referencedRelation: "sandbox_processes"
            referencedColumns: ["id"]
          },
        ]
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
          billing_mode: string
          captured_at: string
          cost_confidence: string
          cost_delta_microusd: number
          cost_provenance: string
          cost_source: string | null
          id: string
          measured_from: string | null
          measured_through: string
          organization_id: string
          project_id: string
          provider: string
          provider_resource_id: string
          rate_card_version: string | null
          raw_payload: Json
          sandbox_id: string
        }
        Insert: {
          amount_microusd: number
          billing_mode?: string
          captured_at?: string
          cost_confidence?: string
          cost_delta_microusd: number
          cost_provenance?: string
          cost_source?: string | null
          id?: string
          measured_from?: string | null
          measured_through: string
          organization_id: string
          project_id: string
          provider: string
          provider_resource_id: string
          rate_card_version?: string | null
          raw_payload: Json
          sandbox_id: string
        }
        Update: {
          amount_microusd?: number
          billing_mode?: string
          captured_at?: string
          cost_confidence?: string
          cost_delta_microusd?: number
          cost_provenance?: string
          cost_source?: string | null
          id?: string
          measured_from?: string | null
          measured_through?: string
          organization_id?: string
          project_id?: string
          provider?: string
          provider_resource_id?: string
          rate_card_version?: string | null
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
      runtime_operations: {
        Row: {
          completed_at: string | null
          created_at: string
          error: Json | null
          id: string
          kind: Database["metal"]["Enums"]["runtime_operation_kind"]
          operation_token: string | null
          organization_id: string
          project_id: string
          provider_capabilities: Json | null
          public_id: string
          request: Json
          result: Json | null
          sandbox_id: string
          started_at: string | null
          state: Database["metal"]["Enums"]["runtime_operation_state"]
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: Json | null
          id?: string
          kind: Database["metal"]["Enums"]["runtime_operation_kind"]
          operation_token?: string | null
          organization_id: string
          project_id: string
          provider_capabilities?: Json | null
          public_id?: string
          request: Json
          result?: Json | null
          sandbox_id: string
          started_at?: string | null
          state?: Database["metal"]["Enums"]["runtime_operation_state"]
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: Json | null
          id?: string
          kind?: Database["metal"]["Enums"]["runtime_operation_kind"]
          operation_token?: string | null
          organization_id?: string
          project_id?: string
          provider_capabilities?: Json | null
          public_id?: string
          request?: Json
          result?: Json | null
          sandbox_id?: string
          started_at?: string | null
          state?: Database["metal"]["Enums"]["runtime_operation_state"]
        }
        Relationships: [
          {
            foreignKeyName: "runtime_operations_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_endpoints: {
        Row: {
          created_at: string
          error: Json | null
          id: string
          lease_expires_at: string
          operation_token: string | null
          organization_id: string
          port: number
          project_id: string
          protocol: string
          provider_capabilities: Json | null
          provider_metadata: Json
          public_id: string
          revoked_at: string | null
          sandbox_id: string
          state: Database["metal"]["Enums"]["sandbox_endpoint_state"]
          updated_at: string
          url: string | null
        }
        Insert: {
          created_at?: string
          error?: Json | null
          id?: string
          lease_expires_at?: string
          operation_token?: string | null
          organization_id: string
          port: number
          project_id: string
          protocol?: string
          provider_capabilities?: Json | null
          provider_metadata?: Json
          public_id?: string
          revoked_at?: string | null
          sandbox_id: string
          state?: Database["metal"]["Enums"]["sandbox_endpoint_state"]
          updated_at?: string
          url?: string | null
        }
        Update: {
          created_at?: string
          error?: Json | null
          id?: string
          lease_expires_at?: string
          operation_token?: string | null
          organization_id?: string
          port?: number
          project_id?: string
          protocol?: string
          provider_capabilities?: Json | null
          provider_metadata?: Json
          public_id?: string
          revoked_at?: string | null
          sandbox_id?: string
          state?: Database["metal"]["Enums"]["sandbox_endpoint_state"]
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_endpoints_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_processes: {
        Row: {
          cancel_requested_at: string | null
          command: Json
          completed_at: string | null
          created_at: string
          cwd: string | null
          environment: Json
          error: Json | null
          exit_code: number | null
          id: string
          max_output_bytes: number
          operation_token: string | null
          organization_id: string
          output_bytes: number
          output_truncated: boolean
          project_id: string
          provider_capabilities: Json | null
          provider_execution_id: string | null
          public_id: string
          sandbox_id: string
          started_at: string | null
          state: Database["metal"]["Enums"]["process_state"]
          termination_signal: string | null
          timeout_seconds: number
        }
        Insert: {
          cancel_requested_at?: string | null
          command: Json
          completed_at?: string | null
          created_at?: string
          cwd?: string | null
          environment?: Json
          error?: Json | null
          exit_code?: number | null
          id?: string
          max_output_bytes?: number
          operation_token?: string | null
          organization_id: string
          output_bytes?: number
          output_truncated?: boolean
          project_id: string
          provider_capabilities?: Json | null
          provider_execution_id?: string | null
          public_id?: string
          sandbox_id: string
          started_at?: string | null
          state?: Database["metal"]["Enums"]["process_state"]
          termination_signal?: string | null
          timeout_seconds?: number
        }
        Update: {
          cancel_requested_at?: string | null
          command?: Json
          completed_at?: string | null
          created_at?: string
          cwd?: string | null
          environment?: Json
          error?: Json | null
          exit_code?: number | null
          id?: string
          max_output_bytes?: number
          operation_token?: string | null
          organization_id?: string
          output_bytes?: number
          output_truncated?: boolean
          project_id?: string
          provider_capabilities?: Json | null
          provider_execution_id?: string | null
          public_id?: string
          sandbox_id?: string
          started_at?: string | null
          state?: Database["metal"]["Enums"]["process_state"]
          termination_signal?: string | null
          timeout_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_processes_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_recordings: {
        Row: {
          created_at: string
          duration_seconds: number | null
          error: Json | null
          file_path: string | null
          format: string
          id: string
          label: string | null
          operation_token: string | null
          organization_id: string
          project_id: string
          provider_capabilities: Json | null
          provider_recording_id: string | null
          public_id: string
          sandbox_id: string
          size_bytes: number | null
          started_at: string | null
          state: Database["metal"]["Enums"]["sandbox_recording_state"]
          stopped_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          error?: Json | null
          file_path?: string | null
          format?: string
          id?: string
          label?: string | null
          operation_token?: string | null
          organization_id: string
          project_id: string
          provider_capabilities?: Json | null
          provider_recording_id?: string | null
          public_id?: string
          sandbox_id: string
          size_bytes?: number | null
          started_at?: string | null
          state?: Database["metal"]["Enums"]["sandbox_recording_state"]
          stopped_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          error?: Json | null
          file_path?: string | null
          format?: string
          id?: string
          label?: string | null
          operation_token?: string | null
          organization_id?: string
          project_id?: string
          provider_capabilities?: Json | null
          provider_recording_id?: string | null
          public_id?: string
          sandbox_id?: string
          size_bytes?: number | null
          started_at?: string | null
          state?: Database["metal"]["Enums"]["sandbox_recording_state"]
          stopped_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_recordings_sandbox_id_fkey"
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
          customer_charged_microusd: number
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
          provider_capabilities: Json | null
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
          customer_charged_microusd?: number
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
          provider_capabilities?: Json | null
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
          customer_charged_microusd?: number
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
          provider_capabilities?: Json | null
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
      stripe_events: {
        Row: {
          event_id: string
          payload: Json
          processed_at: string
          type: string
        }
        Insert: {
          event_id: string
          payload?: Json
          processed_at?: string
          type: string
        }
        Update: {
          event_id?: string
          payload?: Json
          processed_at?: string
          type?: string
        }
        Relationships: []
      }
      usage_charges: {
        Row: {
          created_at: string
          customer_charge_microusd: number
          id: string
          ledger_transaction_id: string
          measured_from: string | null
          measured_through: string
          organization_id: string
          pricing_version_id: string
          project_id: string
          provider_cost_delta_microusd: number
          sandbox_id: string
          snapshot_id: string
        }
        Insert: {
          created_at?: string
          customer_charge_microusd: number
          id?: string
          ledger_transaction_id: string
          measured_from?: string | null
          measured_through: string
          organization_id: string
          pricing_version_id: string
          project_id: string
          provider_cost_delta_microusd: number
          sandbox_id: string
          snapshot_id: string
        }
        Update: {
          created_at?: string
          customer_charge_microusd?: number
          id?: string
          ledger_transaction_id?: string
          measured_from?: string | null
          measured_through?: string
          organization_id?: string
          pricing_version_id?: string
          project_id?: string
          provider_cost_delta_microusd?: number
          sandbox_id?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_charges_ledger_transaction_id_fkey"
            columns: ["ledger_transaction_id"]
            isOneToOne: false
            referencedRelation: "ledger_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_charges_pricing_version_id_fkey"
            columns: ["pricing_version_id"]
            isOneToOne: false
            referencedRelation: "pricing_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_charges_sandbox_id_fkey"
            columns: ["sandbox_id"]
            isOneToOne: false
            referencedRelation: "sandboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_charges_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "provider_cost_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      user_welcome_credit_grants: {
        Row: {
          created_at: string
          credit_microusd: number
          credit_purchase_id: string | null
          organization_id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credit_microusd?: number
          credit_purchase_id?: string | null
          organization_id: string
          status: string
          user_id: string
        }
        Update: {
          created_at?: string
          credit_microusd?: number
          credit_purchase_id?: string | null
          organization_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_welcome_credit_grants_credit_purchase_id_fkey"
            columns: ["credit_purchase_id"]
            isOneToOne: false
            referencedRelation: "credit_purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempt_count: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          endpoint_url: string
          event: Json
          event_id: string
          event_type: string
          id: string
          is_test: boolean
          last_error: string | null
          last_http_status: number | null
          last_latency_ms: number | null
          next_attempt_at: string | null
          organization_id: string
          response_snippet: string | null
          status: Database["metal"]["Enums"]["webhook_delivery_status"]
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          endpoint_url: string
          event: Json
          event_id: string
          event_type: string
          id?: string
          is_test?: boolean
          last_error?: string | null
          last_http_status?: number | null
          last_latency_ms?: number | null
          next_attempt_at?: string | null
          organization_id: string
          response_snippet?: string | null
          status?: Database["metal"]["Enums"]["webhook_delivery_status"]
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          endpoint_url?: string
          event?: Json
          event_id?: string
          event_type?: string
          id?: string
          is_test?: boolean
          last_error?: string | null
          last_http_status?: number | null
          last_latency_ms?: number | null
          next_attempt_at?: string | null
          organization_id?: string
          response_snippet?: string | null
          status?: Database["metal"]["Enums"]["webhook_delivery_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          disabled_at: string | null
          enabled: boolean
          event_types: Json
          id: string
          last_delivery_at: string | null
          last_delivery_status: string | null
          name: string
          organization_id: string
          rotated_at: string | null
          rotated_by: string | null
          secret_id: string
          secret_prefix: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          created_by: string
          deleted_at?: string | null
          disabled_at?: string | null
          enabled?: boolean
          event_types?: Json
          id?: string
          last_delivery_at?: string | null
          last_delivery_status?: string | null
          name: string
          organization_id: string
          rotated_at?: string | null
          rotated_by?: string | null
          secret_id: string
          secret_prefix: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          disabled_at?: string | null
          enabled?: boolean
          event_types?: Json
          id?: string
          last_delivery_at?: string | null
          last_delivery_status?: string | null
          name?: string
          organization_id?: string
          rotated_at?: string | null
          rotated_by?: string | null
          secret_id?: string
          secret_prefix?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
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
      auto_topup_attempt_status:
        | "pending"
        | "succeeded"
        | "failed"
        | "requires_action"
      auto_topup_status: "disabled" | "active" | "paused"
      credit_purchase_source:
        | "checkout"
        | "auto_topup"
        | "admin_grant"
        | "welcome_grant"
      credit_purchase_status:
        | "pending"
        | "paid"
        | "failed"
        | "canceled"
        | "requires_action"
      ledger_account: "customer_credits" | "platform_clearing"
      ledger_transaction_kind:
        | "deposit"
        | "usage_charge"
        | "usage_correction"
        | "adjustment"
      outbox_job_status: "pending" | "leased" | "succeeded" | "failed"
      webhook_delivery_status: "pending" | "delivering" | "succeeded" | "retrying" | "failed"
      pricing_kind: "purchase_fee" | "usage"
      process_state:
        | "queued"
        | "running"
        | "cancelling"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "timed_out"
      runtime_operation_kind:
        | "filesystem_read"
        | "filesystem_write"
        | "filesystem_list"
        | "filesystem_delete"
        | "computer_action"
        | "computer_screenshot"
      runtime_operation_state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
      sandbox_endpoint_state:
        | "provisioning"
        | "active"
        | "revoking"
        | "revoked"
        | "expired"
        | "failed"
      sandbox_recording_state: "starting" | "recording" | "stopping" | "stopped" | "failed"
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
      organization_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          organization_id: string
          revoked_at: string | null
          role: Database["public"]["Enums"]["organization_role"]
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          organization_id: string
          revoked_at?: string | null
          role: Database["public"]["Enums"]["organization_role"]
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          organization_id?: string
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["organization_role"]
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
          deleted_at: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
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
      auto_topup_attempt_status: [
        "pending",
        "succeeded",
        "failed",
        "requires_action",
      ],
      auto_topup_status: ["disabled", "active", "paused"],
      credit_purchase_source: [
        "checkout",
        "auto_topup",
        "admin_grant",
        "welcome_grant",
      ],
      credit_purchase_status: [
        "pending",
        "paid",
        "failed",
        "canceled",
        "requires_action",
      ],
      ledger_account: ["customer_credits", "platform_clearing"],
      ledger_transaction_kind: [
        "deposit",
        "usage_charge",
        "usage_correction",
        "adjustment",
      ],
      outbox_job_status: ["pending", "leased", "succeeded", "failed"],
      webhook_delivery_status: ["pending", "delivering", "succeeded", "retrying", "failed"],
      pricing_kind: ["purchase_fee", "usage"],
      process_state: [
        "queued",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
      ],
      runtime_operation_kind: [
        "filesystem_read",
        "filesystem_write",
        "filesystem_list",
        "filesystem_delete",
        "computer_action",
        "computer_screenshot",
      ],
      runtime_operation_state: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ],
      sandbox_endpoint_state: [
        "provisioning",
        "active",
        "revoking",
        "revoked",
        "expired",
        "failed",
      ],
      sandbox_recording_state: ["starting", "recording", "stopping", "stopped", "failed"],
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

