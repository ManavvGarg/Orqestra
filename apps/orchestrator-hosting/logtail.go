package main

import (
	"bufio"
	"context"
	"io"
	"log"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/redis/go-redis/v9"
)

func startLogTail(dockerCli *client.Client, redisURL, projectID, containerID string) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())

	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Printf("logtail %s: parse redis url: %v", projectID, err)
		cancel()
		return func() {}
	}
	rdb := redis.NewClient(opts)
	channel := "container-logs:" + projectID

	pub := func(line string) {
		if line == "" {
			return
		}
		_ = rdb.Publish(ctx, channel, line).Err()
	}

	go func() {
		defer rdb.Close()
		for ctx.Err() == nil {
			reader, err := dockerCli.ContainerLogs(ctx, containerID, container.LogsOptions{
				ShowStdout: true,
				ShowStderr: true,
				Follow:     true,
				Tail:       "200",
				Timestamps: false,
			})
			if err != nil {
				log.Printf("logtail %s: open: %v", projectID, err)
				select {
				case <-ctx.Done():
					return
				case <-time.After(3 * time.Second):
				}
				continue
			}

			stdoutR, stdoutW := io.Pipe()
			stderrR, stderrW := io.Pipe()
			go publishLines(stdoutR, pub)
			go publishLines(stderrR, pub)

			_, copyErr := stdcopy.StdCopy(stdoutW, stderrW, reader)
			stdoutW.Close()
			stderrW.Close()
			reader.Close()
			if copyErr != nil && ctx.Err() == nil {
				log.Printf("logtail %s: copy: %v", projectID, copyErr)
				time.Sleep(2 * time.Second)
			}
		}
	}()
	return cancel
}

func publishLines(r io.Reader, pub func(string)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		pub(strings.TrimRight(scanner.Text(), "\r\n"))
	}
}
