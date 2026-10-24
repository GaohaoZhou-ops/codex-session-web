# Codex conversation

## User

请解释本地日志的存储方式，并提供一个示例。

## Assistant

我会先检查日志路径。

## Activity

    $ cat config.json
    {"logDirectory": "./data/logs", "searchMarker": "hidden-needle"}
    ✓ • 12ms

## Activity

    $ ls missing-folder
    ls: cannot access 'missing-folder': No such file or directory
    ✗ (2) • 3ms

## Assistant

日志保存在 `./data/logs` 中。

| 文件 | 用途 |
| --- | --- |
| app.log | 应用日志 |
| error.log | 错误日志 |

```python
print("你好，Codex")
```

代码中也可以出现角色标题，它们属于同一条回复：

````markdown
## User
代码内的用户标题
```text
## Assistant
```
````

查看 [日志配置](/workspace/config.json:12) 或 [项目文档](https://example.com/docs)。

## User

如何保留最近七天的日志？

## Assistant

设置 `retention_days` 为 **7**，并定期清理已过期的文件。
