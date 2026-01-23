"""
InsightFlow DuckDB 存储后端

高性能分析型存储，适合时序数据查询
"""

import duckdb
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
import json

from ..core.event import Event, EventType, Insight


class DuckDBStorage:
    """DuckDB 存储实现"""

    def __init__(self, db_path: str = "insightflow.db"):
        """
        初始化存储

        Args:
            db_path: 数据库文件路径
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = None
        self._initialized = False

    def initialize(self) -> None:
        """初始化数据库连接和表结构"""
        if self._initialized:
            return

        self.conn = duckdb.connect(str(self.db_path))

        # 创建事件表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id VARCHAR PRIMARY KEY,
                timestamp TIMESTAMP NOT NULL,
                event_type VARCHAR NOT NULL,
                source VARCHAR NOT NULL,
                session_id VARCHAR,
                content TEXT,
                numeric_value DOUBLE,
                tags VARCHAR,
                data VARCHAR,
                metadata VARCHAR
            )
        """)

        # 创建洞察表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS insights (
                id VARCHAR PRIMARY KEY,
                created_at TIMESTAMP NOT NULL,
                time_window VARCHAR NOT NULL,
                window_start TIMESTAMP,
                window_end TIMESTAMP,
                summary TEXT NOT NULL,
                patterns VARCHAR,
                recommendations VARCHAR,
                confidence DOUBLE,
                source_events_count INTEGER,
                source_event_ids VARCHAR,
                metadata VARCHAR
            )
        """)

        # 创建会话表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id VARCHAR PRIMARY KEY,
                source VARCHAR NOT NULL,
                topic VARCHAR,
                started_at TIMESTAMP NOT NULL,
                ended_at TIMESTAMP,
                status VARCHAR DEFAULT 'active',
                event_count INTEGER DEFAULT 0
            )
        """)

        self._initialized = True

    def close(self) -> None:
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            self.conn = None
            self._initialized = False

    def store_event(self, event: Event) -> str:
        """
        存储单个事件

        Args:
            event: 事件对象

        Returns:
            事件 ID
        """
        self.initialize()

        self.conn.execute("""
            INSERT INTO events (id, timestamp, event_type, source, session_id,
                              content, numeric_value, tags, data, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, [
            event.id,
            event.timestamp,
            event.event_type.value,
            event.source,
            event.session_id,
            event.content,
            event.numeric_value,
            json.dumps(event.tags),
            json.dumps(event.data),
            json.dumps(event.metadata)
        ])

        # 更新会话事件计数
        if event.session_id:
            self.conn.execute("""
                UPDATE sessions SET event_count = event_count + 1
                WHERE id = ?
            """, [event.session_id])

        return event.id

    def store_events(self, events: List[Event]) -> List[str]:
        """批量存储事件"""
        return [self.store_event(e) for e in events]

    def get_events(
        self,
        start_time: datetime,
        end_time: Optional[datetime] = None,
        event_types: Optional[List[str]] = None,
        sources: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        limit: int = 1000
    ) -> List[Event]:
        """
        查询事件

        Args:
            start_time: 开始时间
            end_time: 结束时间（默认当前时间）
            event_types: 事件类型过滤
            sources: 来源过滤
            session_id: 会话 ID 过滤
            limit: 返回数量限制

        Returns:
            事件列表
        """
        self.initialize()

        end_time = end_time or datetime.utcnow()

        query = "SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ?"
        params = [start_time, end_time]

        if event_types:
            placeholders = ",".join(["?" for _ in event_types])
            query += f" AND event_type IN ({placeholders})"
            params.extend(event_types)

        if sources:
            placeholders = ",".join(["?" for _ in sources])
            query += f" AND source IN ({placeholders})"
            params.extend(sources)

        if session_id:
            query += " AND session_id = ?"
            params.append(session_id)

        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        result = self.conn.execute(query, params).fetchall()

        events = []
        for row in result:
            events.append(Event(
                id=row[0],
                timestamp=row[1],
                event_type=EventType(row[2]),
                source=row[3],
                session_id=row[4],
                content=row[5],
                numeric_value=row[6],
                tags=json.loads(row[7]) if row[7] else [],
                data=json.loads(row[8]) if row[8] else {},
                metadata=json.loads(row[9]) if row[9] else {}
            ))

        return events

    def aggregate_events(
        self,
        start_time: datetime,
        end_time: datetime,
        group_by: str = "hour"
    ) -> Dict[str, Any]:
        """
        聚合事件数据

        Args:
            start_time: 开始时间
            end_time: 结束时间
            group_by: 分组方式 (hour/day)

        Returns:
            聚合结果
        """
        self.initialize()

        if group_by == "hour":
            time_format = "%Y-%m-%d %H:00"
            trunc_func = "date_trunc('hour', timestamp)"
        else:
            time_format = "%Y-%m-%d"
            trunc_func = "date_trunc('day', timestamp)"

        # 按时间分组统计
        result = self.conn.execute(f"""
            SELECT
                {trunc_func} as time_bucket,
                event_type,
                source,
                COUNT(*) as count
            FROM events
            WHERE timestamp >= ? AND timestamp <= ?
            GROUP BY time_bucket, event_type, source
            ORDER BY time_bucket
        """, [start_time, end_time]).fetchall()

        by_time = {}
        by_type = {}
        by_source = {}

        for row in result:
            time_key = row[0].strftime(time_format) if row[0] else "unknown"
            event_type = row[1]
            source = row[2]
            count = row[3]

            # 按时间
            by_time[time_key] = by_time.get(time_key, 0) + count
            # 按类型
            by_type[event_type] = by_type.get(event_type, 0) + count
            # 按来源
            by_source[source] = by_source.get(source, 0) + count

        # 获取总数
        total = self.conn.execute("""
            SELECT COUNT(*) FROM events
            WHERE timestamp >= ? AND timestamp <= ?
        """, [start_time, end_time]).fetchone()[0]

        return {
            "total": total,
            "by_time": by_time,
            "by_type": by_type,
            "by_source": by_source,
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat()
        }

    def store_insight(self, insight: Insight) -> str:
        """存储洞察"""
        self.initialize()

        self.conn.execute("""
            INSERT INTO insights (id, created_at, time_window, window_start, window_end,
                                summary, patterns, recommendations, confidence,
                                source_events_count, source_event_ids, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, [
            insight.id,
            insight.created_at,
            insight.time_window,
            insight.window_start,
            insight.window_end,
            insight.summary,
            json.dumps(insight.patterns),
            json.dumps(insight.recommendations),
            insight.confidence,
            insight.source_events_count,
            json.dumps(insight.source_event_ids),
            json.dumps(insight.metadata)
        ])

        return insight.id

    def get_insights(
        self,
        start_time: Optional[datetime] = None,
        time_window: Optional[str] = None,
        limit: int = 100
    ) -> List[Insight]:
        """查询洞察"""
        self.initialize()

        query = "SELECT * FROM insights WHERE 1=1"
        params = []

        if start_time:
            query += " AND created_at >= ?"
            params.append(start_time)

        if time_window:
            query += " AND time_window = ?"
            params.append(time_window)

        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        result = self.conn.execute(query, params).fetchall()

        insights = []
        for row in result:
            insights.append(Insight(
                id=row[0],
                created_at=row[1],
                time_window=row[2],
                window_start=row[3],
                window_end=row[4],
                summary=row[5],
                patterns=json.loads(row[6]) if row[6] else [],
                recommendations=json.loads(row[7]) if row[7] else [],
                confidence=row[8] or 0.0,
                source_events_count=row[9] or 0,
                source_event_ids=json.loads(row[10]) if row[10] else [],
                metadata=json.loads(row[11]) if row[11] else {}
            ))

        return insights

    # 会话管理
    def start_session(self, source: str, topic: Optional[str] = None) -> str:
        """开始会话"""
        self.initialize()
        import uuid
        session_id = str(uuid.uuid4())

        self.conn.execute("""
            INSERT INTO sessions (id, source, topic, started_at, status)
            VALUES (?, ?, ?, ?, 'active')
        """, [session_id, source, topic, datetime.utcnow()])

        return session_id

    def end_session(self, session_id: str) -> None:
        """结束会话"""
        self.initialize()
        self.conn.execute("""
            UPDATE sessions SET ended_at = ?, status = 'ended'
            WHERE id = ?
        """, [datetime.utcnow(), session_id])

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """获取会话信息"""
        self.initialize()
        result = self.conn.execute("""
            SELECT * FROM sessions WHERE id = ?
        """, [session_id]).fetchone()

        if not result:
            return None

        return {
            "id": result[0],
            "source": result[1],
            "topic": result[2],
            "started_at": result[3].isoformat() if result[3] else None,
            "ended_at": result[4].isoformat() if result[4] else None,
            "status": result[5],
            "event_count": result[6]
        }
