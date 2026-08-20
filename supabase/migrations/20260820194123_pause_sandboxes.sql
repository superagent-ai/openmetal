alter type metal.sandbox_status add value if not exists 'pausing' after 'ready';
alter type metal.sandbox_status add value if not exists 'paused' after 'pausing';
